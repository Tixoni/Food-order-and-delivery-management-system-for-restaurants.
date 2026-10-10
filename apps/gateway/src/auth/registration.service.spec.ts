import { ValidationError } from "@food-delivery/shared";
import { loadConfig } from "../config/configuration";
import type { AccountDirectory, AccountRecord, NewAccount } from "./keycloak-admin.client";
import { RegistrationService } from "./registration.service";

class FakeDirectory implements AccountDirectory {
  readonly accounts = new Map<string, AccountRecord & { password: string }>();
  readonly sent: string[] = [];

  async create(account: NewAccount): Promise<string | null> {
    if (this.accounts.has(account.email)) return null;
    const id = `user-${this.accounts.size + 1}`;
    this.accounts.set(account.email, { id, emailVerified: false, password: account.password });
    return id;
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    return this.accounts.get(email) ?? null;
  }

  async sendVerificationEmail(userId: string): Promise<void> {
    this.sent.push(userId);
  }
}

describe("RegistrationService (AUTH-1)", () => {
  let directory: FakeDirectory;
  let service: RegistrationService;

  beforeEach(() => {
    directory = new FakeDirectory();
    service = new RegistrationService(directory, { ...loadConfig(), logLevel: "error" });
  });

  it("creates the account and sends the verification email", async () => {
    const result = await service.register({
      email: "  Anna@Example.com ",
      password: "long-enough",
      name: "Анна",
    });

    expect(result).toEqual({ status: "verification-sent", email: "anna@example.com" });
    expect(directory.accounts.get("anna@example.com")?.emailVerified).toBe(false);
    expect(directory.sent).toEqual(["user-1"]);
  });

  it("answers the same for a taken address and resends only while unverified", async () => {
    await service.register({ email: "anna@example.com", password: "long-enough" });
    const again = await service.register({ email: "anna@example.com", password: "other-pass" });

    expect(again).toEqual({ status: "verification-sent", email: "anna@example.com" });
    expect(directory.sent).toEqual(["user-1", "user-1"]);
    // Пароль существующей учётной записи повторной регистрацией не меняется.
    expect(directory.accounts.get("anna@example.com")?.password).toBe("long-enough");

    directory.accounts.get("anna@example.com")!.emailVerified = true;
    await service.register({ email: "anna@example.com", password: "long-enough" });
    expect(directory.sent).toHaveLength(2);
  });

  it("does not reveal unknown addresses on resend", async () => {
    await expect(service.resend("nobody@example.com")).resolves.toEqual({
      status: "verification-sent",
      email: "nobody@example.com",
    });
    expect(directory.sent).toHaveLength(0);
  });

  it.each([
    [{ email: "not-an-email", password: "long-enough" }, "e-mail"],
    [{ email: "anna@example.com", password: "short" }, "не меньше 8"],
    [{ email: "anna.petrova@example.com", password: "Anna.Petrova" }, "не должен совпадать"],
    [{ email: "anna@example.com", password: "long-enough", name: "я".repeat(101) }, "имя"],
  ])("rejects invalid input %#", async (input, message) => {
    await expect(service.register(input)).rejects.toThrow(ValidationError);
    await expect(service.register(input)).rejects.toThrow(message);
    expect(directory.accounts.size).toBe(0);
  });
});
