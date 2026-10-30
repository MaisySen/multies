import Foundation

/// Keeps the Better Auth cookies and sends them back as a Cookie header.
public struct CookieJar: Equatable, Sendable {
    public private(set) var values: [String: String] = [:]
    public init(_ values: [String: String] = [:]) { self.values = values }

    public var header: String { values.keys.sorted().map { "\($0)=\(values[$0]!)" }.joined(separator: "; ") }
    public var hasSession: Bool { values.keys.contains { $0.hasSuffix("session_token") } }

    /// Applies one or more Set-Cookie headers. Commas inside Expires dates are not separators.
    public mutating func apply(setCookie header: String) {
        for cookie in CookieJar.split(header) {
            let parts = cookie.split(separator: ";", omittingEmptySubsequences: false).map { $0.trimmingCharacters(in: .whitespaces) }
            guard let pair = parts.first, let eq = pair.firstIndex(of: "="), eq != pair.startIndex else { continue }
            let name = String(pair[..<eq])
            let value = String(pair[pair.index(after: eq)...])
            let expired = parts.dropFirst().contains { attr in
                let kv = attr.split(separator: "=", maxSplits: 1).map(String.init)
                return kv.first?.lowercased() == "max-age" && (Int(kv.count > 1 ? kv[1] : "1") ?? 1) <= 0
            }
            if expired || value.isEmpty { values.removeValue(forKey: name) } else { values[name] = value }
        }
    }

    static func split(_ header: String) -> [String] {
        var out: [String] = []
        var current = ""
        let chars = Array(header)
        var i = 0
        while i < chars.count {
            let c = chars[i]
            if c == "," {
                // A new cookie starts when the next token looks like name=value before any ; or ,
                let rest = String(chars[(i + 1)...])
                let token = rest.trimmingCharacters(in: .whitespaces).prefix { $0 != ";" && $0 != "," }
                if token.contains("="), !token.hasPrefix(" ") {
                    out.append(current.trimmingCharacters(in: .whitespaces)); current = ""; i += 1; continue
                }
            }
            current.append(c); i += 1
        }
        if !current.trimmingCharacters(in: .whitespaces).isEmpty { out.append(current.trimmingCharacters(in: .whitespaces)) }
        return out
    }
}
