/**
 * Ошибки предметной области заказа.
 *
 * Свои классы, а не общие ошибки приложения: домен не знает про коды HTTP.
 * Перевод в ответ клиенту выполняет слой сценариев.
 */

/** Нарушено правило заказа: сумма, состав, время готовки. */
export class OrderRuleError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "OrderRuleError";
  }
}

/**
 * Перехода нет в таблице переходов (ORD-3).
 *
 * Отдельный класс, потому что смысл у него другой: правило не нарушено,
 * просто заказ уже в другом состоянии — например, клиент отменяет заказ,
 * который ресторан только что принял. Это конфликт состояний, а не ошибка ввода.
 */
export class InvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
    readonly actor: string,
  ) {
    super(`переход ${from} → ${to} недопустим для ${actor}`);
    this.name = "InvalidTransitionError";
  }
}
