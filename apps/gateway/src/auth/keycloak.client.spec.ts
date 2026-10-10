import { ForbiddenError, UnauthorizedError } from "@food-delivery/shared";
import { loadConfig } from "../config/configuration";
import { EMAIL_NOT_VERIFIED, KeycloakClient } from "./keycloak.client";

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("KeycloakClient.login", () => {
  const originalFetch = global.fetch;
  const client = new KeycloakClient({ ...loadConfig(), logLevel: "error" });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("tells an unverified e-mail apart from a wrong password (AUTH-1)", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        reply(400, { error: "invalid_grant", error_description: "Account is not fully set up" }),
      );

    const failure = await client.login("anna@example.com", "right-password").catch((e) => e);
    expect(failure).toBeInstanceOf(ForbiddenError);
    expect(failure.details).toEqual({ reason: EMAIL_NOT_VERIFIED });
  });

  it("keeps the generic answer for wrong credentials", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue(
        reply(401, { error: "invalid_grant", error_description: "Invalid user credentials" }),
      );

    await expect(client.login("anna@example.com", "wrong")).rejects.toThrow(UnauthorizedError);
  });
});
