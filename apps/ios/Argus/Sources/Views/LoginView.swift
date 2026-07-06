import SwiftUI
import ArgusKit

/// Server + credentials in one screen — self-hosted deployments mean the
/// server URL is as much a credential as the password. Server and email
/// prefill from the last successful login.
struct LoginView: View {
    @Environment(AppModel.self) private var app

    @State private var server = ""
    @State private var email = ""
    @State private var password = ""
    @State private var busy = false
    @State private var errorMessage: String?

    private var canSubmit: Bool {
        !busy && !server.isEmpty && !email.isEmpty && !password.isEmpty
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 4) {
                        HStack(spacing: 8) {
                            Circle().fill(.green).frame(width: 10, height: 10)
                            Text("Argus")
                                .font(.largeTitle.bold())
                        }
                        Text("Agent management · multi-machine control plane")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }

                Section("Server") {
                    TextField("argus.example.com:4000", text: $server)
                        .textContentType(.URL)
                        .keyboardType(.URL)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                }

                Section("Account") {
                    TextField("Email", text: $email)
                        .textContentType(.username)
                        .keyboardType(.emailAddress)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                    SecureField("Password", text: $password)
                        .textContentType(.password)
                        .onSubmit { if canSubmit { submit() } }
                }

                if let errorMessage {
                    Section {
                        Text(errorMessage)
                            .font(.callout)
                            .foregroundStyle(.red)
                    }
                }

                Section {
                    Button(action: submit) {
                        if busy {
                            ProgressView().frame(maxWidth: .infinity)
                        } else {
                            Text("Sign in").frame(maxWidth: .infinity)
                        }
                    }
                    .disabled(!canSubmit)
                }
            }
        }
        .onAppear {
            if server.isEmpty { server = app.savedServer }
            if email.isEmpty { email = app.savedEmail }
        }
    }

    private func submit() {
        busy = true
        errorMessage = nil
        Task {
            defer { busy = false }
            do {
                try await app.logIn(server: server, email: email, password: password)
            } catch {
                errorMessage = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }
}
