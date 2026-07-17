// swift-tools-version: 6.0
import PackageDescription

// ArgusKit — all non-UI logic for the native Argus client: wire models,
// REST client, Socket.IO realtime layer, and the transcript engine.
//
// Builds with Command Line Tools alone (`swift build`); `swift test`
// needs full Xcode (Swift Testing ships with Xcode's SDK, not the bare
// toolchain) — CI runs both on a macOS runner (.github/workflows/ios.yml).
//
// Language mode v6 (strict concurrency = complete). SocketIO is the one
// unmigrated dependency — StreamClient imports it @preconcurrency, the
// sanctioned boundary for third-party modules that haven't adopted
// Sendable yet.
let package = Package(
    name: "ArgusKit",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [
        .library(name: "ArgusKit", targets: ["ArgusKit"])
    ],
    dependencies: [
        .package(url: "https://github.com/socketio/socket.io-client-swift", from: "16.1.0")
    ],
    targets: [
        .target(
            name: "ArgusKit",
            dependencies: [
                .product(name: "SocketIO", package: "socket.io-client-swift")
            ]
        ),
        .testTarget(
            name: "ArgusKitTests",
            dependencies: ["ArgusKit"],
            resources: [.copy("Fixtures")]
        ),
    ],
    swiftLanguageModes: [.v6]
)
