/**
 * Деньги в проекте — всегда целое число копеек.
 *
 * Дробные числа для денег непригодны: 0.1 + 0.2 в двоичной арифметике
 * даёт 0.30000000000000004, и при сложении позиций заказа копейки
 * начинают теряться. Ошибка на копейку в чеке — это расхождение
 * с платёжным шлюзом и разбирательство вручную.
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
  /** Надбавка модификатора может быть отрицательной: скидка за меньший размер. */
  allowNegative?: boolean;
}

export function assertMoney(
  value: number,
  field: string,
  options: MoneyOptions = {},
): asserts value is Kopecks {
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
