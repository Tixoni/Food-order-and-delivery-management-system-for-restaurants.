import { type CanActivate, type ExecutionContext, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import { ForbiddenError, UnauthorizedError } from "@food-delivery/shared";
import { PUBLIC_KEY, ROLES_KEY } from "./auth.decorators";
import { TokenVerifier } from "./token-verifier";
import type { Role } from "./auth.types";

/**
 * Проверка входа и прав на каждом запросе — требование SEC-2.
 *
 * Обработчик закрыт, пока не помечен как открытый. Такой порядок выбран
 * намеренно: список закрытых методов растёт с каждой возможностью, и рано
 * или поздно один из них забудут закрыть. Обратная ошибка — забыть открыть
 * общедоступный метод — обнаруживается сразу, на первом же обращении.
 *
 * Проверка роли не заменяет проверку владения ресурсом. Роль отвечает
 * на вопрос «имеет ли право вообще», принадлежность — «имеет ли право
 * на этот объект»; вторую проверяет сценарий, потому что она относится
 * к предметной области, а не к способу входа.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly verifier: TokenVerifier,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const handler = [context.getHandler(), context.getClass()];

    const isPublic = this.reflector.getAllAndOverride<boolean>(PUBLIC_KEY, handler);
    const request = this.requestOf(context);
    const token = extractBearer(request.headers?.authorization);

    // У открытого метода токен не обязателен, но если он пришёл —
    // разбирается: выдача может зависеть от того, кто смотрит.
    if (isPublic) {
      if (token) {
        request.user = await this.verifier.verify(token).catch(() => undefined);
      }
      return true;
    }

    if (!token) {
      throw new UnauthorizedError("требуется вход в систему");
    }

    const user = await this.verifier.verify(token);
    request.user = user;

    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, handler) ?? [];
    if (required.length > 0 && !required.some((role) => user.roles.includes(role))) {
      throw new ForbiddenError("недостаточно прав для этого действия", {
        required,
        actual: user.roles,
      });
    }

    return true;
  }

  /**
   * Откуда брать запрос.
   *
   * Отдельный метод нужен, чтобы шлюз мог переопределить его для GraphQL:
   * там запрос лежит в контексте выполнения иначе, чем в обычном
   * обработчике HTTP. Иначе пришлось бы либо заводить второй сторож
   * с теми же правилами, либо тащить зависимость от GraphQL в общий
   * каркас, который нужен и сервисам без него.
   */
  protected requestOf(context: ExecutionContext): AuthenticatedRequest {
    return context.switchToHttp().getRequest();
  }
}

/** Запрос, к которому сторож прикладывает проверенного пользователя. */
export interface AuthenticatedRequest {
  headers?: { authorization?: string };
  user?: unknown;
}

/**
 * Токен берётся только из заголовка Authorization. Ни строка запроса,
 * ни тело для этого не годятся: строка запроса попадает в журналы
 * веб-сервера и в историю браузера целиком, вместе с токеном.
 */
function extractBearer(header: unknown): string | null {
  if (typeof header !== "string") return null;

  const [scheme, value] = header.split(" ");
  return scheme?.toLowerCase() === "bearer" && value ? value : null;
}
