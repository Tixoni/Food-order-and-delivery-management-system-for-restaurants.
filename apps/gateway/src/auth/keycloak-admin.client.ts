import { Inject, Injectable } from "@nestjs/common";
import {
  ExternalServiceError,
  ValidationError,
  createLogger,
  type Logger,
} from "@food-delivery/shared";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/**
 * Служебный доступ шлюза к учётным записям провайдера входа — только
 * для регистрации клиентов (AUTH-1).
 *
 * Почему регистрация идёт через шлюз, а не через страницу провайдера:
 * на шлюзе действует то же ограничение частоты, что и на входе (SEC-5),
 * а интерфейс регистрации остаётся частью приложения. Пароль, как и при
 * входе, не задерживается в шлюзе и сразу уходит провайдеру (SEC-6).
 *
 * Права служебного приложения урезаны до управления учётными записями:
 * роль новому пользователю шлюз не назначает — её выдаёт сама область
 * (роль по умолчанию `client`), поэтому через регистрацию нельзя завести
 * сотрудника или администратора.
 */

export interface NewAccount {
  email: string;
  password: string;
  firstName?: string;
}

export interface AccountRecord {
  id: string;
  emailVerified: boolean;
}

/** Порт для службы регистрации: в тестах подменяется. */
export interface AccountDirectory {
  /** Создаёт учётную запись; `null` — e-mail уже занят. */
  create(account: NewAccount): Promise<string | null>;
  findByEmail(email: string): Promise<AccountRecord | null>;
  sendVerificationEmail(userId: string): Promise<void>;
}

export const ACCOUNT_DIRECTORY = Symbol("AccountDirectory");

interface ServiceToken {
  value: string;
  expiresAt: number;
}

@Injectable()
export class KeycloakAdminClient implements AccountDirectory {
  private readonly logger: Logger;
  private token: ServiceToken | null = null;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "keycloak-admin",
    });
  }

  async create(account: NewAccount): Promise<string | null> {
    const response = await this.admin("/users", {
      method: "POST",
      body: {
        username: account.email,
        email: account.email,
        firstName: account.firstName,
        enabled: true,
        emailVerified: false,
        // Пока ссылка из письма не открыта, провайдер не выдаёт токенов.
        requiredActions: ["VERIFY_EMAIL"],
        credentials: [{ type: "password", value: account.password, temporary: false }],
      },
    });

    if (response.status === 409) return null;
    if (response.status === 400) {
      // Политика паролей области (длина, несовпадение с e-mail) проверяется
      // провайдером; его сообщение пересказывается, сам пароль — нет.
      const failure = (await response.json().catch(() => ({}))) as { errorMessage?: string };
      throw new ValidationError(passwordProblem(failure.errorMessage));
    }
    if (response.status !== 201) {
      throw new ExternalServiceError("провайдер входа не создал учётную запись", {
        status: response.status,
      });
    }

    const location = response.headers.get("location") ?? "";
    const id = location.split("/").pop();
    if (!id) {
      throw new ExternalServiceError("провайдер входа не вернул идентификатор учётной записи");
    }
    return id;
  }

  async findByEmail(email: string): Promise<AccountRecord | null> {
    const query = new URLSearchParams({ email, exact: "true", briefRepresentation: "true" });
    const response = await this.admin(`/users?${query.toString()}`, { method: "GET" });
    if (!response.ok) {
      throw new ExternalServiceError("провайдер входа не ответил на поиск учётной записи", {
        status: response.status,
      });
    }

    const users = (await response.json()) as Array<{ id: string; emailVerified?: boolean }>;
    const user = users[0];
    return user ? { id: user.id, emailVerified: user.emailVerified === true } : null;
  }

  /**
   * Письмо со ссылкой подтверждения отправляет сам провайдер: в ссылке —
   * подписанный им одноразовый токен действия, и проверять его тоже ему.
   * После подтверждения провайдер ведёт обратно в приложение, на вход.
   */
  async sendVerificationEmail(userId: string): Promise<void> {
    const query = new URLSearchParams({
      client_id: this.config.auth.clientId,
      redirect_uri: `${this.config.auth.appUrl}/login?verified=1`,
    });
    const response = await this.admin(`/users/${userId}/send-verify-email?${query.toString()}`, {
      method: "PUT",
    });
    if (!response.ok) {
      throw new ExternalServiceError("провайдер входа не отправил письмо", {
        status: response.status,
      });
    }
  }

  private async admin(
    path: string,
    init: { method: string; body?: unknown },
    retried = false,
  ): Promise<Response> {
    const token = await this.serviceToken();
    const response = await this.fetch(`${this.adminBase()}${path}`, {
      method: init.method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

    // Токен мог истечь раньше расчётного срока, например после перезапуска
    // провайдера: один повтор со свежим токеном.
    if (response.status === 401 && !retried) {
      this.token = null;
      return this.admin(path, init, true);
    }
    return response;
  }

  /** Токен служебного приложения; переиспользуется до истечения срока. */
  private async serviceToken(): Promise<string> {
    if (this.token && this.token.expiresAt > Date.now()) return this.token.value;

    const response = await this.fetch(`${this.realmBase()}/protocol/openid-connect/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: this.config.auth.adminClientId,
        client_secret: this.config.auth.adminClientSecret,
      }).toString(),
    });
    if (!response.ok) {
      this.logger.error("служебное приложение шлюза не получило токен", undefined, {
        status: response.status,
      });
      throw new ExternalServiceError("регистрация временно недоступна");
    }

    const body = (await response.json()) as { access_token: string; expires_in: number };
    // Запас в 30 секунд — чтобы токен не истёк по дороге к провайдеру.
    this.token = {
      value: body.access_token,
      expiresAt: Date.now() + Math.max(0, body.expires_in - 30) * 1000,
    };
    return this.token.value;
  }

  private realmBase(): string {
    return this.config.auth.providerUrl ?? this.config.auth.issuer;
  }

  /** `…/realms/<область>` → `…/admin/realms/<область>`. */
  private adminBase(): string {
    return this.realmBase().replace("/realms/", "/admin/realms/");
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, { ...init, signal: AbortSignal.timeout(this.config.auth.timeoutMs) });
    } catch (error) {
      throw new ExternalServiceError("провайдер входа не ответил", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}

function passwordProblem(message: string | undefined): string {
  switch (message) {
    case "invalidPasswordMinLengthMessage":
      return "пароль слишком короткий: нужно не меньше 8 символов";
    case "invalidPasswordNotUsernameMessage":
    case "invalidPasswordNotEmailMessage":
      return "пароль не должен совпадать с e-mail";
    default:
      return "пароль не подходит по правилам безопасности";
  }
}
