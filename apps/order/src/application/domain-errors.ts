import { ConflictError, DomainRuleError } from "@food-delivery/shared";
import { InvalidTransitionError, OrderRuleError } from "../domain/order-errors";

const STATUS_TEXT: Record<string, string> = {
  CREATED: "создан",
  PENDING_PAYMENT: "ожидает оплаты",
  PAID: "оплачен",
  AWAITING_RESTAURANT: "ожидает подтверждения рестораном",
  COOKING: "готовится",
  READY: "готов",
  ASSIGNING_COURIER: "ожидает курьера",
  IN_TRANSIT: "в пути",
  DELIVERED: "доставлен",
  CANCELLED: "отменён",
};

/**
 * Перевод ошибок домена в ошибки приложения.
 *
 * Нарушенное правило — ответ 422 с текстом правила. Недопустимый переход —
 * конфликт 409: заказ уже в другом состоянии (например, ресторан принял его,
 * пока клиент нажимал «отменить»), и клиенту нужно перечитать заказ.
 */
export function toAppError(error: unknown): unknown {
  if (error instanceof OrderRuleError) return new DomainRuleError(error.message, error.details);
  if (error instanceof InvalidTransitionError) {
    return new ConflictError(
      `действие недоступно: заказ ${STATUS_TEXT[error.from] ?? error.from}`,
      {
        status: error.from,
        requested: error.to,
      },
    );
  }
  return error;
}

/** Выполнить действие домена, переведя его ошибки в ошибки приложения. */
export function domain<T>(action: () => T): T {
  try {
    return action();
  } catch (error) {
    throw toAppError(error);
  }
}
