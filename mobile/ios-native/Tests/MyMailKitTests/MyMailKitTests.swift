import XCTest
@testable import MyMailKit

final class MyMailKitTests: XCTestCase {
    func testCookieJarKeepsSessionAndDropsExpired() {
        var jar = CookieJar()
        jar.apply(setCookie: "__Secure-mymail.session_token=tok.sig; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly, mymail.two_factor=x; Max-Age=600")
        XCTAssertEqual(jar.values, ["__Secure-mymail.session_token": "tok.sig", "mymail.two_factor": "x"])
        XCTAssertTrue(jar.hasSession)
        jar.apply(setCookie: "mymail.two_factor=; Max-Age=0")
        XCTAssertEqual(jar.header, "__Secure-mymail.session_token=tok.sig")
    }

    func testErrorShapes() {
        let ba = APIError.from(status: 401, body: Data(#"{"code":"INVALID_EMAIL_OR_PASSWORD","message":"Invalid"}"#.utf8))
        XCTAssertEqual(ba.message, "That email and password don't match.")
        let app = APIError.from(status: 400, body: Data(#"{"error":{"code":"bad_request","message":"Add a recipient"}}"#.utf8))
        XCTAssertEqual(app, APIError(status: 400, code: "bad_request", message: "Add a recipient"))
    }

    func testDecodesApprovalFromTheAPI() throws {
        let json = #"{"approvals":[{"id":"apr_1","agentId":"agt_1","mailboxId":"mbx","threadId":null,"status":"pending","to":["a@b.au"],"cc":[],"bcc":[],"subject":"Invoice","text":"Hi","html":null,"inReplyToId":null,"decidedBy":null,"decidedAt":null,"note":null,"messageId":null,"error":null,"expiresAt":"2026-10-25T00:00:00Z","createdAt":"2026-10-24T00:00:00Z"}]}"#
        struct R: Decodable { let approvals: [Approval] }
        let r = try JSONDecoder().decode(R.self, from: Data(json.utf8))
        XCTAssertEqual(r.approvals.first?.status, .pending)
        XCTAssertEqual(r.approvals.first?.to, ["a@b.au"])
    }

    func testRequestCarriesCookieAndOrigin() {
        let c = MyMailClient(base: URL(string: "https://mymail.example")!, jar: CookieJar(["__Secure-mymail.session_token": "t"]))
        let req = c.makeRequest("POST", "/approvals/apr_1/approve", body: Data("{}".utf8))
        XCTAssertEqual(req.url?.absoluteString, "https://mymail.example/api/approvals/apr_1/approve")
        XCTAssertEqual(req.value(forHTTPHeaderField: "cookie"), "__Secure-mymail.session_token=t")
        XCTAssertEqual(req.value(forHTTPHeaderField: "origin"), "https://mymail.example")
    }
}
