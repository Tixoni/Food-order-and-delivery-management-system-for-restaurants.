import { timingSafeEqual } from "node:crypto";
import { Inject, Injectable, type CanActivate, type ExecutionContext } from "@nestjs/common";
import { UnauthorizedError } from "@food-delivery/shared";

/** Заголовок со служебным токеном внутреннего API. */
export const INTERNAL_TOKEN_HEADER = "x-internal-token";

/** Метка для внедрения ожидаемого токена. */
export const INTERNAL_TOKEN = Symbol("InternalToken");

/**
 * Доступ к внутреннему API сервиса — только для соседей, знающих общий
 * служебный токен.
 *
 * Внутренний API не выходит наружу через шлюз, но одной сетевой изоляции
 * для денежного контура мало: любой процесс в сети контейнеров мог бы
 * списать или вернуть деньги. Токен — отдельный ключ доступа платёжного
 * сервиса, известный только вызывающему (`order`). Токен пользователя
 * здесь не подходит: операции выполняет оркестратор, а не человек.
 *
 * Сравнение — за постоянное время: по времени ответа нельзя подбирать
 * токен посимвольно.
 */
@Injectable()
export class InternalTokenGuard implements CanActivate {
  private readonly expected: Buffer;

  constructor(@Inject(INTERNAL_TOKEN) token: string) {
    this.expected = Buffer.from(token);
  }

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<{ headers: Record<string, unknown> }>();
    const header = request.headers[INTERNAL_TOKEN_HEADER];
    const presented = Buffer.from(typeof header === "string" ? header : "");

    if (presented.length !== this.expected.length || !timingSafeEqual(presented, this.expected)) {
      throw new UnauthorizedError("внутренний API: неверный служебный токен");
    }
    return true;
  }
}
