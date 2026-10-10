/**
 * Ошибки предметной области платежа.
 *
 * Свои классы, а не общие ошибки приложения: домен не знает про коды HTTP.
 * Перевод в ответ вызывающему выполняет слой сценариев.
 */

/** Нарушено правило платежа: списать неавторизованное, вернуть больше списанного. */
export class PaymentRuleError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "PaymentRuleError";
  }
}
