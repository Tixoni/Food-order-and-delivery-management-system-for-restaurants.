import type { ExecutionContext } from "@nestjs/common";
import { UnauthorizedError } from "@food-delivery/shared";
import { INTERNAL_TOKEN_HEADER, InternalTokenGuard } from "./internal-token.guard";

const contextWith = (headers: Record<string, unknown>) =>
  ({
    switchToHttp: () => ({ getRequest: () => ({ headers }) }),
  }) as unknown as ExecutionContext;

describe("InternalTokenGuard", () => {
  const guard = new InternalTokenGuard("service-secret");

  it("пропускает запрос с верным служебным токеном", () => {
    expect(guard.canActivate(contextWith({ [INTERNAL_TOKEN_HEADER]: "service-secret" }))).toBe(
      true,
    );
  });

  it.each([
    ["без токена", {}],
    ["с неверным токеном той же длины", { [INTERNAL_TOKEN_HEADER]: "service-secreT" }],
    ["с токеном другой длины", { [INTERNAL_TOKEN_HEADER]: "s" }],
    ["с токеном пользователя вместо служебного", { authorization: "Bearer service-secret" }],
  ])("отклоняет запрос %s", (_name, headers) => {
    expect(() => guard.canActivate(contextWith(headers))).toThrow(UnauthorizedError);
  });
});
