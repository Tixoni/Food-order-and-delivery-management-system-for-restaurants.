import { Body, Controller, Get, HttpCode, HttpStatus, Post, Req, Res } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import {
  CurrentUser,
  Public,
  TokenVerifier,
  type AuthenticatedUser,
} from "@food-delivery/service-kit";
import { KeycloakClient, type TokenPair } from "./keycloak.client";
import { LoginRateLimiter } from "./login-rate-limiter";
import { RegistrationService, type RegistrationInput } from "./registration.service";

/**
 * Вход в систему через шлюз.
 *
 * Почему вход проходит через шлюз, а не напрямую к провайдеру:
 * ограничение частоты попыток (SEC-5) можно наложить только там, где
 * проходит запрос, а браузер, обращающийся прямо к провайдеру, такому
 * ограничению не подчиняется. Заодно шлюз кладёт refresh-token
 * в закрытую для сценариев страницы куку.
 *
 * Разделение токенов принципиально (AUTH-4 и замечание о безопасности
 * в заметке «20 — Клиентские приложения»):
 *   токен доступа — в ответе, приложение держит его в памяти и теряет
 *     при перезагрузке вкладки, зато он живёт 15 минут;
 *   refresh-token — в куке HttpOnly: сценарий страницы его не прочитает,
 *     а значит, кража через внедрённый сценарий не даёт вечного доступа.
 */

const REFRESH_COOKIE = "fd_refresh";

interface LoginBody {
  username?: string;
  password?: string;
}

interface Request {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  socket?: { remoteAddress?: string };
}

interface Response {
  cookie?: (name: string, value: string, options: Record<string, unknown>) => void;
  clearCookie?: (name: string, options: Record<string, unknown>) => void;
  setHeader: (name: string, value: string) => void;
}

@Controller("auth")
export class AuthController {
  constructor(
    private readonly keycloak: KeycloakClient,
    private readonly rateLimiter: LoginRateLimiter,
    private readonly verifier: TokenVerifier,
    private readonly registration: RegistrationService,
  ) {}

  /**
   * Регистрация клиента (AUTH-1). Учётная запись создаётся сразу, но войти
   * в неё можно только после перехода по ссылке из письма.
   */
  @Public()
  @Post("register")
  @HttpCode(HttpStatus.ACCEPTED)
  async register(@Body() body: RegistrationInput, @Req() request: Request) {
    await this.rateLimiter.check(addressOf(request), "register");
    return this.registration.register(body);
  }

  /** Повторная отправка письма, если первое потерялось или ссылка истекла. */
  @Public()
  @Post("verification/resend")
  @HttpCode(HttpStatus.ACCEPTED)
  async resendVerification(@Body() body: { email?: string }, @Req() request: Request) {
    await this.rateLimiter.check(addressOf(request), "register");
    return this.registration.resend(body.email);
  }

  @Public()
  @Post("login")
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginBody,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const username = body.username?.trim();
    const password = body.password;

    if (!username || !password) {
      throw new ValidationError("нужны имя пользователя и пароль");
    }

    const clientIp = addressOf(request);
    await this.rateLimiter.check(clientIp);

    const tokens = await this.keycloak.login(username, password);
    await this.rateLimiter.reset(clientIp);

    return this.respondWithTokens(tokens, response);
  }

  /** Продление сеанса: refresh-token берётся из куки, а не из тела запроса. */
  @Public()
  @Post("refresh")
  @HttpCode(HttpStatus.OK)
  async refresh(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = cookieValue(request, REFRESH_COOKIE);
    if (!refreshToken) {
      throw new ValidationError("сеанс не найден: войдите заново");
    }

    const tokens = await this.keycloak.refresh(refreshToken);
    return this.respondWithTokens(tokens, response);
  }

  @Public()
  @Post("logout")
  @HttpCode(HttpStatus.OK)
  async logout(@Req() request: Request, @Res({ passthrough: true }) response: Response) {
    const refreshToken = cookieValue(request, REFRESH_COOKIE);
    if (refreshToken) {
      await this.keycloak.logout(refreshToken);
    }

    response.clearCookie?.(REFRESH_COOKIE, { path: "/auth" });
    return { ok: true };
  }

  /**
   * Кто вошёл. Клиентская часть спрашивает это при запуске, чтобы решить,
   * какие разделы показывать. Права всё равно проверяются на сервере при
   * каждом обращении (SEC-2) — здесь только удобство.
   */
  @Get("me")
  async me(@CurrentUser() user?: AuthenticatedUser) {
    return {
      id: user?.id,
      email: user?.email,
      name: user?.name,
      roles: user?.roles ?? [],
      restaurantId: user?.restaurantId,
    };
  }

  private async respondWithTokens(tokens: TokenPair, response: Response) {
    response.cookie?.(REFRESH_COOKIE, tokens.refreshToken, {
      httpOnly: true,
      sameSite: "lax",
      // В рабочем окружении весь трафик идёт по TLS (SEC-1), и кука
      // помечается как secure; на локальной машине без TLS такая кука
      // не сохранится, поэтому признак зависит от окружения.
      secure: process.env.NODE_ENV === "production",
      // Кука нужна только обработчикам входа: чем уже путь, тем меньше
      // мест, откуда она может утечь.
      path: "/auth",
      maxAge: 30 * 24 * 60 * 60 * 1000,
    });

    const user = await this.verifier.verify(tokens.accessToken);

    return {
      accessToken: tokens.accessToken,
      expiresIn: tokens.expiresIn,
      tokenType: tokens.tokenType,
      user: {
        id: user.id,
        email: user.email,
        name: user.name,
        roles: user.roles,
        restaurantId: user.restaurantId,
      },
    };
  }
}

/**
 * Адрес обратившегося. За обратным прокси настоящий адрес приходит
 * заголовком; первым в списке стоит адрес клиента, остальные добавляют
 * промежуточные узлы.
 */
function addressOf(request: Request): string {
  const forwarded = request.headers["x-forwarded-for"];
  const header = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const fromHeader = header?.split(",")[0]?.trim();

  return fromHeader || request.ip || request.socket?.remoteAddress || "unknown";
}

/** Разбор куки из заголовка: ради одного значения подключать разборщик незачем. */
function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.cookie;
  if (typeof header !== "string") return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }

  return null;
}
