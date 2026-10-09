import { Injectable, type ExecutionContext } from "@nestjs/common";
import { GqlExecutionContext } from "@nestjs/graphql";
import { AuthGuard, type AuthenticatedRequest } from "@food-delivery/service-kit";

/**
 * Тот же сторож доступа, но умеющий доставать запрос из контекста GraphQL.
 *
 * Правила проверки не повторяются — наследуются: второй набор правил
 * доступа неизбежно разошёлся бы с первым, и разойтись он мог бы молча.
 * Переопределяется только место, откуда берётся запрос.
 */
@Injectable()
export class GqlAuthGuard extends AuthGuard {
  protected override requestOf(context: ExecutionContext): AuthenticatedRequest {
    // У обычных обработчиков HTTP (проверки работоспособности, вход)
    // контекст прежний, поэтому сначала пробуем GraphQL и откатываемся.
    const gql = GqlExecutionContext.create(context).getContext<{ req?: AuthenticatedRequest }>();

    return gql?.req ?? super.requestOf(context);
  }
}
