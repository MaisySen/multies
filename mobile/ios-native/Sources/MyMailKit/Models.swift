import Foundation

/// The same shapes as the API's OpenAPI spec (components.schemas.Approval and Agent).
public struct Approval: Codable, Identifiable, Equatable, Sendable {
    public enum Status: String, Codable, Sendable { case pending, sent, rejected, failed, expired }
    public let id: String
    public let agentId: String
    public let mailboxId: String
    public let threadId: String?
    public var status: Status
    public let to: [String]
    public let cc: [String]
    public var subject: String
    public var text: String
    public let note: String?
    public let expiresAt: String
    public let createdAt: String
}

public struct Agent: Codable, Identifiable, Equatable, Sendable {
    public let id: String
    public let name: String
    public let address: String
    public let pendingApprovals: Int
}

public struct Me: Codable, Equatable, Sendable {
    public struct User: Codable, Equatable, Sendable { public let id: String; public let email: String; public let name: String; public let twoFactor: Bool }
    public struct Organization: Codable, Equatable, Sendable { public let id: String; public let name: String; public let plan: String }
    public let user: User
    public let organization: Organization?
}

public struct APIError: Error, Equatable, Sendable {
    public let status: Int
    public let code: String
    public let message: String

    static let friendly: [String: String] = [
        "INVALID_EMAIL_OR_PASSWORD": "That email and password don't match.",
        "INVALID_CODE": "That code didn't work. Check your authenticator app and try again.",
        "TOO_MANY_REQUESTS": "Too many attempts. Wait a minute and try again.",
    ]

    /// Reads both error shapes: the app's {"error":{"code","message"}} and Better Auth's {"code","message"}.
    public static func from(status: Int, body: Data) -> APIError {
        struct Inner: Decodable { let code: String?; let message: String? }
        struct Outer: Decodable { let error: Inner?; let code: String?; let message: String? }
        let o = try? JSONDecoder().decode(Outer.self, from: body)
        let code = o?.error?.code ?? o?.code ?? (status == 429 ? "TOO_MANY_REQUESTS" : "error")
        let message = friendly[code.uppercased()] ?? o?.error?.message ?? o?.message ?? "Something went wrong (\(status))."
        return APIError(status: status, code: code.lowercased(), message: message)
    }
}
