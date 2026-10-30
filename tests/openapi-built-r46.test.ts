import { describe, it, expect } from "vitest";
import { v1Routes, buildOpenApiText, OPENAPI_ORIGIN_PLACEHOLDER } from "../src/server/routes/v1";

/** R46: the Worker serves the build's copy of the v1 document with the origin filled in; it must equal the live one. */
describe("R46 built OpenAPI document", () => {
  it("equals the document the route builds, once the origin is filled in", () => {
    const built = buildOpenApiText(v1Routes(), OPENAPI_ORIGIN_PLACEHOLDER);
    expect(built.split(OPENAPI_ORIGIN_PLACEHOLDER).length).toBe(2); // the placeholder appears exactly once
    expect(built.replace(OPENAPI_ORIGIN_PLACEHOLDER, "https://multies.si")).toBe(buildOpenApiText(v1Routes(), "https://multies.si"));
  });
});
