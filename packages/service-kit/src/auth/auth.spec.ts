import type { ExecutionContext } from "@nestjs/common";
import type { Reflector } from "@nestjs/core";
import { ForbiddenError, UnauthorizedError } from "@food-delivery/shared";
import { AuthGuard } from "./auth.guard";
import { PUBLIC_KEY, ROLES_KEY } from "./auth.decorators";
import { TokenVerifier } from "./token-verifier";
import { ROLES, type Role, type TokenClaims } from "./auth.types";

/** Токен без подписи: проверяется разбор, а не криптография. */
const tokenWith = (claims: Partial<TokenClaims>): string => {
  const payload = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `header.${payload}.signature`;
};

const verifier = () =>
  new TokenVerifier({ issuer: "http://kc/realms/x", audience: "api", disabled: true });

/**
 * Заглушка чтения пометок: настоящий Reflector читает метаданные,
 * записанные декораторами, и для проверки самого сторожа это лишний слой.
 */
const reflectorWith = (metadata: Record<string, unknown>): Reflector =>
  ({
    getAllAndOverride: (key: string) => metadata[key],
  }) as unknown as Reflector;

const contextWith = (authorization?: string) => {
  const request: { headers: Record<string, string>; user?: unknown } = {
    headers: authorization ? { authorization } : {},
  };

  return {
    request,
    context: {
      getHandler: () => () => undefined,
      getClass: () => class {},
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext,
  };
};

describe("разбор токена", () => {
  it("достаёт пользователя и роли", async () => {
    const user = await verifier().verify(
      tokenWith({
        sub: "u-1",
        email: "manager@food.local",
        realm_access: { roles: ["manager"] },
      }),
    );

    expect(user.id).toBe("u-1");
    expect(user.email).toBe("manager@food.local");
    expect(user.roles).toEqual(["manager"]);
  });

  it("отбрасывает роли, не относящиеся к системе", async () => {
    const user = await verifier().verify(
      tokenWith({
        sub: "u-1",
        realm_access: { roles: ["manager", "offline_access", "uma_authorization"] },
      }),
    );

    expect(user.roles).toEqual([ROLES.manager]);
  });

  it("переносит привязку сотрудника к ресторану", async () => {
    const user = await verifier().verify(
      tokenWith({ sub: "u-1", realm_access: { roles: ["manager"] }, restaurantId: "r-1" }),
    );

    expect(user.restaurantId).toBe("r-1");
  });

  it("токен без пользователя не принимается", async () => {
    await expect(verifier().verify(tokenWith({ email: "x@y.z" }))).rejects.toThrow(
      UnauthorizedError,
    );
  });

  it("испорченный токен не принимается", async () => {
    await expect(verifier().verify("совсем-не-токен")).rejects.toThrow(UnauthorizedError);
    await expect(verifier().verify("a.!!!.c")).rejects.toThrow(UnauthorizedError);
  });

  it("пользователь без ролей получает пустой список, а не отказ", async () => {
    const user = await verifier().verify(tokenWith({ sub: "u-1" }));

    expect(user.roles).toEqual([]);
  });
});

describe("сторож доступа", () => {
  const guard = (metadata: Record<string, unknown>) =>
    new AuthGuard(reflectorWith(metadata), verifier());

  const managerToken = tokenWith({ sub: "u-1", realm_access: { roles: ["manager"] } });

  it("закрывает обработчик, не помеченный как открытый", async () => {
    const { context } = contextWith();

    await expect(guard({}).canActivate(context)).rejects.toThrow(UnauthorizedError);
  });

  it("пропускает открытый обработчик без токена", async () => {
    const { context, request } = contextWith();

    await expect(guard({ [PUBLIC_KEY]: true }).canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it("на открытом обработчике разбирает токен, если он есть", async () => {
    const { context, request } = contextWith(`Bearer ${managerToken}`);

    await guard({ [PUBLIC_KEY]: true }).canActivate(context);

    expect(request.user).toMatchObject({ id: "u-1" });
  });

  it("испорченный токен не мешает открытому обработчику ответить", async () => {
    const { context, request } = contextWith("Bearer не-токен");

    await expect(guard({ [PUBLIC_KEY]: true }).canActivate(context)).resolves.toBe(true);
    expect(request.user).toBeUndefined();
  });

  it("пропускает закрытый обработчик с действительным токеном", async () => {
    const { context, request } = contextWith(`Bearer ${managerToken}`);

    await expect(guard({}).canActivate(context)).resolves.toBe(true);
    expect(request.user).toMatchObject({ roles: ["manager"] });
  });

  it("пропускает обладателя нужной роли", async () => {
    const { context } = contextWith(`Bearer ${managerToken}`);

    await expect(
      guard({ [ROLES_KEY]: [ROLES.manager] as Role[] }).canActivate(context),
    ).resolves.toBe(true);
  });

  it("отказывает при недостатке прав", async () => {
    const { context } = contextWith(`Bearer ${managerToken}`);

    await expect(
      guard({ [ROLES_KEY]: [ROLES.admin] as Role[] }).canActivate(context),
    ).rejects.toThrow(ForbiddenError);
  });

  it("достаточно одной подходящей роли из перечисленных", async () => {
    const { context } = contextWith(`Bearer ${managerToken}`);

    await expect(
      guard({ [ROLES_KEY]: [ROLES.admin, ROLES.manager] as Role[] }).canActivate(context),
    ).resolves.toBe(true);
  });

  it("принимает токен только из заголовка Authorization по схеме Bearer", async () => {
    const wrongScheme = contextWith(`Basic ${managerToken}`);

    await expect(guard({}).canActivate(wrongScheme.context)).rejects.toThrow(UnauthorizedError);
  });
});
