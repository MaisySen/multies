/** W4 (Semgrep): the PIN salt comes from a cryptographic source or the lock is not set at all. */

describe("PIN salt", () => {
  const realCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto");
  afterEach(() => {
    jest.resetModules();
    if (realCrypto) Object.defineProperty(globalThis, "crypto", realCrypto);
  });

  it("uses expo-crypto's random bytes when it has them", () => {
    jest.isolateModules(() => {
      jest.doMock("expo-crypto", () => ({ getRandomBytes: (n: number) => new Uint8Array(n).fill(171) }));
      const { newSalt } = require("@/lib/app-lock");
      expect(newSalt()).toBe("ab".repeat(16));
    });
  });

  it("falls back to crypto.getRandomValues, never Math.random", () => {
    jest.isolateModules(() => {
      jest.doMock("expo-crypto", () => ({}));
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: { getRandomValues: (a: Uint8Array) => a.fill(18) } });
      const spy = jest.spyOn(Math, "random");
      const { newSalt } = require("@/lib/app-lock");
      expect(newSalt()).toBe("12".repeat(16));
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    });
  });

  it("refuses to make a salt (and so a PIN) with no secure source", () => {
    jest.isolateModules(() => {
      jest.doMock("expo-crypto", () => ({}));
      Object.defineProperty(globalThis, "crypto", { configurable: true, value: undefined });
      const { newSalt } = require("@/lib/app-lock");
      expect(() => newSalt()).toThrow(/secure PIN/);
    });
  });
});
