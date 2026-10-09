import { Inject, Injectable } from "@nestjs/common";
import {
  ExternalServiceError,
  UnauthorizedError,
  createLogger,
  type Logger,
} from "@food-delivery/shared";
import { GATEWAY_CONFIG, type GatewayConfig } from "../config/configuration";

/**
 * Обращение к провайдеру входа.
 *
 * Пароль проходит через шлюз и нигде не задерживается: он не пишется
 * в журнал (SEC-3, SEC-4 — поля с паролем маскируются общим журналом)
 * и не сохраняется ни в каком виде. Сама система паролей не хранит —
 * это требование SEC-6, и именно поэтому проверку выполняет провайдер.
 */

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  /** Через сколько секунд истекает токен доступа. */
  expiresIn: number;
  tokenType: string;
}

interface KeycloakTokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
}

@Injectable()
export class KeycloakClient {
  private readonly logger: Logger;

  constructor(@Inject(GATEWAY_CONFIG) private readonly config: GatewayConfig) {
    this.logger = createLogger({ service: "gateway", level: config.logLevel }).child({
      component: "keycloak",
    });
  }

  /** Вход по имени и паролю (AUTH-2). */
  async login(username: string, password: string): Promise<TokenPair> {
    return this.token({
      grant_type: "password",
      client_id: this.config.auth.clientId,
      username,
      password,
      scope: "openid",
    });
  }

  /** Продление сеанса без повторного ввода пароля (AUTH-4). */
  async refresh(refreshToken: string): Promise<TokenPair> {
    return this.token({
      grant_type: "refresh_token",
      client_id: this.config.auth.clientId,
      refresh_token: refreshToken,
    });
  }

  /**
   * Выход. Провайдеру сообщается, что выданный refresh-token больше
   * недействителен: без этого токен оставался бы рабочим до истечения срока,
   * и «выход» на общем компьютере не означал бы выхода.
   */
  async logout(refreshToken: string): Promise<void> {
    const response = await this.post("/protocol/openid-connect/logout", {
      client_id: this.config.auth.clientId,
      refresh_token: refreshToken,
    });

    if (!response.ok) {
      this.logger.warn("провайдер не подтвердил выход", { status: response.status });
    }
  }

  private async token(form: Record<string, string>): Promise<TokenPair> {
    const response = await this.post("/protocol/openid-connect/token", form);

    if (response.status === 401 || response.status === 400) {
      // Что именно не подошло — имя или пароль — наружу не сообщается:
      // иначе по ответу можно перебирать существующие учётные записи.
      throw new UnauthorizedError("неверное имя пользователя или пароль");
    }
    if (!response.ok) {
      throw new ExternalServiceError("провайдер входа недоступен", { status: response.status });
    }

    const body = (await response.json()) as KeycloakTokenResponse;

    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresIn: body.expires_in,
      tokenType: body.token_type,
    };
  }

  private async post(path: string, form: Record<string, string>): Promise<Response> {
    const url = `${this.config.auth.issuer}${path}`;

    try {
      return await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(form).toString(),
        // Провайдер не должен заставлять клиента ждать неопределённо долго.
        signal: AbortSignal.timeout(this.config.auth.timeoutMs),
      });
    } catch (error) {
      throw new ExternalServiceError("провайдер входа не ответил", {
        reason: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
