#if canImport(SwiftUI)
import SwiftUI
import MyMailKit

@MainActor @Observable
final class ApprovalsModel {
    let client = MyMailClient()
    var signedIn = false
    var needsCode = false
    var approvals: [Approval] = []
    var agents: [String: String] = [:]
    var error: String?
    var busy = false

    func signIn(email: String, password: String) async {
        await run { if try await self.client.signIn(email: email, password: password) == .twoFactor { self.needsCode = true } else { self.signedIn = true; await self.load() } }
    }
    func verify(code: String) async {
        await run { try await self.client.verifyTotp(code); self.needsCode = false; self.signedIn = true; await self.load() }
    }
    func load() async {
        await run {
            async let a = self.client.pendingApprovals()
            async let g = self.client.agents()
            self.approvals = try await a
            self.agents = Dictionary(uniqueKeysWithValues: try await g.map { ($0.id, $0.name) })
        }
    }
    func decide(_ a: Approval, approve: Bool) async {
        await run {
            _ = approve ? try await self.client.approve(a.id) : try await self.client.reject(a.id)
            self.approvals.removeAll { $0.id == a.id }
        }
    }
    private func run(_ work: @escaping () async throws -> Void) async {
        busy = true; error = nil
        do { try await work() } catch let e as APIError { error = e.message } catch { self.error = "Can't reach MyMail. Check your connection." }
        busy = false
    }
}

struct RootView: View {
    @Environment(ApprovalsModel.self) private var model
    var body: some View {
        NavigationStack {
            if model.signedIn { ApprovalsView() } else if model.needsCode { CodeView() } else { SignInView() }
        }
    }
}

struct SignInView: View {
    @Environment(ApprovalsModel.self) private var model
    @State private var email = ""
    @State private var password = ""
    var body: some View {
        Form {
            Section { TextField("Email", text: $email).textContentType(.username).keyboardType(.emailAddress).textInputAutocapitalization(.never)
                      SecureField("Password", text: $password).textContentType(.password) }
            if let e = model.error { Text(e).foregroundStyle(.red) }
            Button(model.busy ? "Signing in" : "Sign in") { Task { await model.signIn(email: email, password: password) } }.disabled(model.busy)
        }.navigationTitle("MyMail")
    }
}

struct CodeView: View {
    @Environment(ApprovalsModel.self) private var model
    @State private var code = ""
    var body: some View {
        Form {
            TextField("6 digit code", text: $code).textContentType(.oneTimeCode).keyboardType(.numberPad)
            if let e = model.error { Text(e).foregroundStyle(.red) }
            Button("Verify") { Task { await model.verify(code: code) } }.disabled(model.busy)
        }.navigationTitle("Two step sign in")
    }
}

struct ApprovalsView: View {
    @Environment(ApprovalsModel.self) private var model
    var body: some View {
        List {
            if model.approvals.isEmpty { ContentUnavailableView("Nothing waiting", systemImage: "checkmark.circle", description: Text("When an agent asks to send, it shows up here.")) }
            ForEach(model.approvals) { a in
                VStack(alignment: .leading, spacing: 8) {
                    Label(model.agents[a.agentId] ?? "Agent", systemImage: "cpu").font(.subheadline).foregroundStyle(.tint)
                    Text("To \(a.to.joined(separator: ", "))").font(.footnote).foregroundStyle(.secondary)
                    Text(a.subject).font(.headline)
                    Text(a.text).font(.body).lineLimit(4).foregroundStyle(.secondary)
                    HStack {
                        Button("Approve") { Task { await model.decide(a, approve: true) } }.buttonStyle(.borderedProminent)
                        Button("Reject", role: .destructive) { Task { await model.decide(a, approve: false) } }.buttonStyle(.bordered)
                    }
                }.padding(.vertical, 6)
            }
            if let e = model.error { Text(e).foregroundStyle(.red) }
        }
        .navigationTitle("Approvals")
        .refreshable { await model.load() }
    }
}
#endif
