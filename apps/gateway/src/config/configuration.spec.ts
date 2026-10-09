import { loadConfig } from "./configuration";

describe("Gateway configuration", () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthDisabled = process.env.AUTH_DISABLED;

  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthDisabled === undefined) delete process.env.AUTH_DISABLED;
    else process.env.AUTH_DISABLED = originalAuthDisabled;
  });

  it("refuses unsigned tokens in production", () => {
    process.env.NODE_ENV = "production";
    process.env.AUTH_DISABLED = "true";
    expect(() => loadConfig()).toThrow("AUTH_DISABLED запрещён в production");
  });

  it("allows the isolated verification mode in development", () => {
    process.env.NODE_ENV = "development";
    process.env.AUTH_DISABLED = "true";
    expect(loadConfig().auth.disabled).toBe(true);
  });
});
