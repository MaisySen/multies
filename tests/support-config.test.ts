import { describe, it, expect } from "vitest";
import { makeTestApp, Client } from "./helpers";

describe("support address", () => {
  it("is in the public config, from SUPPORT_EMAIL when set", async () => {
    const plain = await makeTestApp();
    expect((await new Client(plain.app).get("/api/config")).body.supportEmail).toBe("support@mymail.au");
    const set = await makeTestApp({ SUPPORT_EMAIL: "help@example.com" });
    expect((await new Client(set.app).get("/api/config")).body.supportEmail).toBe("help@example.com");
  });
});
