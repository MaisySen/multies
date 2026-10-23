import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// A small client for the MyMail session API. The React Native app uses the same endpoints.
public final class MyMailClient: @unchecked Sendable {
    public let base: URL
    public private(set) var jar: CookieJar
    private let session: URLSession
    public var onJarChange: ((CookieJar) -> Void)?

    public init(base: URL = URL(string: "https://mymail.mymail-app.workers.dev")!, jar: CookieJar = CookieJar(), session: URLSession = .shared) {
        self.base = base
        self.jar = jar
        self.session = session
    }

    public enum SignIn: Equatable { case done, twoFactor }

    public func signIn(email: String, password: String) async throws -> SignIn {
        struct R: Decodable { let twoFactorRedirect: Bool? }
        jar = CookieJar()
        let r: R = try await send("POST", "/auth/sign-in/email", body: ["email": email.lowercased(), "password": password, "rememberMe": true])
        return r.twoFactorRedirect == true ? .twoFactor : .done
    }

    public func verifyTotp(_ code: String) async throws {
        struct Empty: Decodable {}
        let _: Empty = try await send("POST", "/auth/two-factor/verify-totp", body: ["code": code.filter(\.isNumber), "trustDevice": true])
    }

    public func me() async throws -> Me { try await send("GET", "/account/me") }

    public func pendingApprovals() async throws -> [Approval] {
        struct R: Decodable { let approvals: [Approval] }
        let r: R = try await send("GET", "/approvals?status=pending")
        return r.approvals
    }

    public func agents() async throws -> [Agent] {
        struct R: Decodable { let agents: [Agent] }
        let r: R = try await send("GET", "/agents")
        return r.agents
    }

    public func approve(_ id: String) async throws -> Approval {
        struct R: Decodable { let approval: Approval }
        let r: R = try await send("POST", "/approvals/\(id)/approve", body: [String: String]())
        return r.approval
    }

    public func reject(_ id: String, note: String? = nil) async throws -> Approval {
        struct R: Decodable { let approval: Approval }
        let r: R = try await send("POST", "/approvals/\(id)/reject", body: note.map { ["note": $0] } ?? [:])
        return r.approval
    }

    public func makeRequest(_ method: String, _ path: String, body: Data?) -> URLRequest {
        var req = URLRequest(url: URL(string: "/api" + path, relativeTo: base)!)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "accept")
        req.setValue(base.absoluteString.trimmingCharacters(in: CharacterSet(charactersIn: "/")), forHTTPHeaderField: "origin")
        req.httpShouldHandleCookies = false
        if !jar.header.isEmpty { req.setValue(jar.header, forHTTPHeaderField: "cookie") }
        if let body { req.httpBody = body; req.setValue("application/json", forHTTPHeaderField: "content-type") }
        return req
    }

    private func send<T: Decodable>(_ method: String, _ path: String, body: [String: Any]? = nil) async throws -> T {
        let data = try body.map { try JSONSerialization.data(withJSONObject: $0) }
        let (bytes, response) = try await session.data(for: makeRequest(method, path, body: data))
        guard let http = response as? HTTPURLResponse else { throw APIError(status: 0, code: "network", message: "Can't reach MyMail.") }
        if let setCookie = http.value(forHTTPHeaderField: "set-cookie") { jar.apply(setCookie: setCookie); onJarChange?(jar) }
        guard (200..<300).contains(http.statusCode) else { throw APIError.from(status: http.statusCode, body: bytes) }
        return try JSONDecoder().decode(T.self, from: bytes.isEmpty ? Data("{}".utf8) : bytes)
    }
}
