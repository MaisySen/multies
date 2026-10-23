import { applySetCookie, cookieHeader, hasSession, splitSetCookie } from "@/lib/cookies";

describe("cookie jar", () => {
  it("splits combined Set-Cookie headers without breaking on Expires dates", () => {
    const h = "__Secure-mymail.session_token=abc.def; Path=/; Expires=Wed, 21 Oct 2099 07:28:00 GMT; HttpOnly, mymail.two_factor=xyz; Path=/; Max-Age=600";
    expect(splitSetCookie(h)).toHaveLength(2);
    const jar = applySetCookie({}, h);
    expect(jar).toEqual({ "__Secure-mymail.session_token": "abc.def", "mymail.two_factor": "xyz" });
    expect(cookieHeader(jar)).toBe("__Secure-mymail.session_token=abc.def; mymail.two_factor=xyz");
    expect(hasSession(jar)).toBe(true);
  });

  it("removes cookies the server expires", () => {
    const jar = { "mymail.two_factor": "xyz", "__Secure-mymail.session_token": "s" };
    const next = applySetCookie(jar, "mymail.two_factor=; Max-Age=0; Path=/");
    expect(next).toEqual({ "__Secure-mymail.session_token": "s" });
    expect(applySetCookie(next, "__Secure-mymail.session_token=gone; Expires=Thu, 01 Jan 1970 00:00:00 GMT")).toEqual({});
  });

  it("ignores a missing header", () => {
    expect(applySetCookie({ a: "1" }, null)).toEqual({ a: "1" });
    expect(hasSession({ other: "1" })).toBe(false);
  });
});
