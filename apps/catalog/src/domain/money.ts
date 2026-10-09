/**
 * Деньги в проекте — всегда целое число копеек.
 *
 * 390 рублей записываются как 39000.
 */
export type Kopecks = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export interface MoneyOptions {
  /** Разрешает отрицательное денежное значение. */
  allowNegative?: boolean;
}

/**
 * Проверяет, что значение — корректная сумма в копейках, и бросает
 * MoneyError, если нет.
 */
export function assertMoney(value: number, field: string, options: MoneyOptions = {}): void {
  if (!Number.isInteger(value)) {
    throw new MoneyError(`${field}: сумма должна быть целым числом копеек, получено ${value}`);
  }
  if (!options.allowNegative && value < 0) {
    throw new MoneyError(`${field}: сумма не может быть отрицательной, получено ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new MoneyError(`${field}: сумма выходит за пределы точного представления`);
  }
}

/** Для сообщений пользователю и записей журнала: 39000 → «390,00 ₽». */
export function formatKopecks(value: Kopecks): string {
  const sign = value < 0 ? "−" : "";
  const abs = Math.abs(value);
  return `${sign}${Math.trunc(abs / 100)},${String(abs % 100).padStart(2, "0")} ₽`;
}
