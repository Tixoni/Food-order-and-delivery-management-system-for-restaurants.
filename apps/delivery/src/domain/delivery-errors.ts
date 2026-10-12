/**
 * Ошибки предметной области доставки. Домен не знает про коды HTTP —
 * перевод в ответ выполняет слой сценариев.
 */

/** Нарушено правило: «доставил» до «забрал», смена без учётной записи. */
export class DeliveryRuleError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DeliveryRuleError";
  }
}

/**
 * Действие опоздало: предложение уже закрыто или просрочено, доставку
 * уже забрал другой курьер. Это конфликт состояний, а не ошибка ввода.
 */
export class DeliveryConflictError extends Error {
  constructor(
    message: string,
    readonly details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "DeliveryConflictError";
  }
}
