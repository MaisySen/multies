describe("build flags", () => {
  const saved = { ...process.env };
  afterEach(() => { process.env = { ...saved }; jest.resetModules(); });

  it("registers for server push by default", () => {
    delete process.env.EXPO_PUBLIC_FEATURE_PUSH_SERVER;
    const { FEATURES } = require("@/config");
    expect(FEATURES).toEqual({ tasks: true, pushServer: true });
  });

  it("lets a build switch server push off", () => {
    process.env.EXPO_PUBLIC_FEATURE_PUSH_SERVER = "0";
    const { FEATURES } = require("@/config");
    expect(FEATURES.pushServer).toBe(false);
  });
});
