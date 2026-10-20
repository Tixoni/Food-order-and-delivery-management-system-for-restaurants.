import { Inject, Injectable } from "@nestjs/common";
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";
import { UnauthorizedError } from "@food-delivery/shared";
import {
  AUTH_OPTIONS,
  ROLES,
  type AuthOptions,
  type AuthenticatedUser,
  type Role,
  type TokenClaims,
} from "./auth.types";

/**
 * Проверка токена доступа.
 *
 * Подпись проверяется по открытым ключам провайдера, которые библиотека
 * забирает один раз и держит в памяти. Обращения к провайдеру на каждый
 * запрос нет — иначе провайдер входа стал бы узким местом и точкой отказа
 * для всей системы (REL-2), а время ответа выросло бы на сетевой вызов.
 *
 * Проверяются три вещи, и все три обязательны:
 *   подпись — токен выдан именно нашим провайдером, а не подделан;
 *   срок    — истёкший токен не принимается;
 *   получатель — токен, выписанный для другой системы, здесь не годится.
 */
@Injectable()
export class TokenVerifier {
  private readonly jwks: JWTVerifyGetKey | null;

  constructor(@Inject(AUTH_OPTIONS) private readonly options: AuthOptions) {
    this.jwks = options.disabled
      ? null
      : createRemoteJWKSet(
          new URL(`${options.providerUrl ?? options.issuer}/protocol/openid-connect/certs`),
          {
            // Ключи провайдера меняются редко; без кэша каждый запрос
            // с новым ключом приводил бы к походу в сеть.
            cacheMaxAge: 10 * 60 * 1000,
            cooldownDuration: 30 * 1000,
          },
        );
  }

  async verify(token: string): Promise<AuthenticatedUser> {
    if (!this.jwks) {
      // Режим без провайдера входа: токен разбирается, но не проверяется.
      // Допустимо только в тестах, см. AuthOptions.disabled.
      return this.toUser(decodeWithoutVerification(token));
    }

    try {
      const { payload } = await jwtVerify(token, this.jwks, {
        issuer: this.options.issuer,
        audience: this.options.audience,
        // Часы сервиса и провайдера расходятся на секунды; без допуска
        // только что выданный токен иногда считается ещё не действующим.
        clockTolerance: 5,
      });

      return this.toUser(payload as TokenClaims);
    } catch {
      // Наружу уходит общая причина: подробности о том, чем именно
      // не подошёл токен, облегчают подбор.
      throw new UnauthorizedError("токен недействителен");
    }
  }

  private toUser(claims: TokenClaims): AuthenticatedUser {
    if (!claims.sub) {
      throw new UnauthorizedError("в токене нет идентификатора пользователя");
    }

    const known = new Set<string>(Object.values(ROLES));
    // Неизвестные роли отбрасываются: провайдер может выдавать
    // служебные роли, к правам в системе отношения не имеющие.
    const roles = (claims.realm_access?.roles ?? []).filter((role): role is Role =>
      known.has(role),
    );

    return {
      id: claims.sub,
      ...(claims.email ? { email: claims.email } : {}),
      ...((claims.name ?? claims.preferred_username)
        ? { name: claims.name ?? claims.preferred_username }
        : {}),
      roles,
      ...(claims.restaurantId ? { restaurantId: claims.restaurantId } : {}),
    };
  }
}

/** Разбор полезной нагрузки без проверки подписи. Только для режима без провайдера. */
function decodeWithoutVerification(token: string): TokenClaims {
  const [, payload] = token.split(".");
  if (!payload) {
    throw new UnauthorizedError("токен имеет неверный формат");
  }

  try {
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    throw new UnauthorizedError("токен имеет неверный формат");
  }
}
