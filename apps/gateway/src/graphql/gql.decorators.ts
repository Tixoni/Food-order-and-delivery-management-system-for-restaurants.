import { createParamDecorator, type ExecutionContext } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import type { AuthenticatedUser } from "@food-delivery/service-kit";

/**
 * Пользователь и его токен в параметрах разрешающей функции.
 *
 * Отдельные пометки от тех, что в общем каркасе: там запрос берётся
 * из контекста HTTP, здесь — из контекста GraphQL. Общий каркас нужен
 * и сервисам без GraphQL, и тащить в него эту зависимость незачем.
 */

const requestOf = (context: ExecutionContext) =>
  GqlExecutionContext.create(context).getContext<{
    req?: { user?: AuthenticatedUser; headers?: { authorization?: string } };
  }>()?.req;

export const GqlUser = createParamDecorator(
  (_data: unknown, context: ExecutionContext): AuthenticatedUser | undefined =>
    requestOf(context)?.user,
);

/**
 * Токен доступа как он пришёл. Нужен, чтобы передать его дальше в сервис:
 * права проверяет владелец данных, а не шлюз (SEC-2).
 */
export const AccessToken = createParamDecorator(
  (_data: unknown, context: ExecutionContext): string | undefined => {
    const header = requestOf(context)?.headers?.authorization;
    if (typeof header !== "string") return undefined;

    const [scheme, value] = header.split(" ");
    return scheme?.toLowerCase() === "bearer" && value ? value : undefined;
  },
);
