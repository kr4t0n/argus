import Foundation
import UIKit
import UserNotifications

/// Owns everything UNUserNotificationCenter / remote-notification
/// registration. AppModel wires the three closures after login:
///   - onDeviceToken: POST the APNs token to /me/devices
///   - onOpenSession: deep-link a notification tap to its session
///   - shouldSuppress: true while the user is already viewing that
///     session (matches the web: never nag about something on screen)
@MainActor
final class PushManager: NSObject {
    static let shared = PushManager()

    var onDeviceToken: ((String) -> Void)?
    var onOpenSession: ((String) -> Void)?
    var shouldSuppress: ((String) -> Bool)?

    /// Call once at app start so notification taps route even from a
    /// cold launch.
    func configure() {
        UNUserNotificationCenter.current().delegate = self
    }

    /// Ask for permission (no-op if already granted) and kick off APNs
    /// registration; the token lands in `onDeviceToken` via AppDelegate.
    /// Returns whether the user granted notification permission.
    func requestAndRegister() async -> Bool {
        let center = UNUserNotificationCenter.current()
        let granted = (try? await center.requestAuthorization(
            options: [.alert, .sound, .badge]
        )) ?? false
        if granted {
            UIApplication.shared.registerForRemoteNotifications()
        }
        return granted
    }

    func unregister() {
        UIApplication.shared.unregisterForRemoteNotifications()
    }

    fileprivate func handleToken(_ hexToken: String) {
        onDeviceToken?(hexToken)
    }

    fileprivate nonisolated static func sessionId(from content: UNNotificationContent) -> String? {
        content.userInfo["sessionId"] as? String
    }

    // MARK: Withdrawing delivered banners

    /// Remove delivered completion banners for the given sessions —
    /// matched on the payload's `sessionId` (the alert's collapse id
    /// isn't surfaced by UNUserNotificationCenter). Safe from any
    /// thread; `completion` runs on a background queue.
    ///
    /// `UNUserNotificationCenter.current()` is deliberately re-fetched
    /// inside the closure: the class isn't Sendable, so hoisting it
    /// into a captured local trips `@Sendable`-capture warnings.
    nonisolated static func removeDelivered(
        sessionIds: Set<String>,
        completion: (() -> Void)? = nil
    ) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let ids = delivered
                .filter { sessionId(from: $0.request.content).map(sessionIds.contains) ?? false }
                .map(\.request.identifier)
            if !ids.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
            }
            completion?()
        }
    }

    /// Sweep: any banner whose session is no longer unread was read
    /// elsewhere (or superseded by a fresh turn) while we weren't
    /// looking. The server's clear push handles this live, but it's
    /// best-effort — Apple throttles background pushes and never
    /// delivers them to a force-quit app — so re-derive from fresh
    /// session state whenever we have it.
    nonisolated static func reconcileDelivered(keepingUnread unreadIds: Set<String>) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let stale = delivered
                .filter { note in
                    guard let id = sessionId(from: note.request.content) else { return false }
                    return !unreadIds.contains(id)
                }
                .map(\.request.identifier)
            if !stale.isEmpty {
                UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: stale)
            }
        }
    }
}

extension PushManager: UNUserNotificationCenterDelegate {
    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let sessionId = Self.sessionId(from: notification.request.content)
        Task { @MainActor in
            let suppress = sessionId.map { self.shouldSuppress?($0) ?? false } ?? false
            completionHandler(suppress ? [] : [.banner, .sound, .list])
        }
    }

    nonisolated func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let sessionId = Self.sessionId(from: response.notification.request.content)
        Task { @MainActor in
            if let sessionId { self.onOpenSession?(sessionId) }
            completionHandler()
        }
    }
}

/// SwiftUI apps still need a UIApplicationDelegate for the two
/// remote-notification registration callbacks.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
    ) {
        let hexToken = deviceToken.map { String(format: "%02x", $0) }.joined()
        Task { @MainActor in
            PushManager.shared.handleToken(hexToken)
        }
    }

    func application(
        _ application: UIApplication,
        didFailToRegisterForRemoteNotificationsWithError error: Error
    ) {
        // Expected on Intel-Mac Simulators / missing entitlement; the
        // toggle simply won't produce a registered device.
        print("APNs registration failed: \(error.localizedDescription)")
    }

    /// Silent clear push (server `clearSessionNotification`): the
    /// session was read on another client, or a fresh turn superseded
    /// the result — withdraw its banner from Notification Center.
    func application(
        _ application: UIApplication,
        didReceiveRemoteNotification userInfo: [AnyHashable: Any],
        fetchCompletionHandler completionHandler: @escaping (UIBackgroundFetchResult) -> Void
    ) {
        guard let sessionId = userInfo["clearSessionId"] as? String else {
            completionHandler(.noData)
            return
        }
        PushManager.removeDelivered(sessionIds: [sessionId]) {
            DispatchQueue.main.async { completionHandler(.noData) }
        }
    }
}
