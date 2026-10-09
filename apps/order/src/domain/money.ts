import { OrderRuleError } from "./order-errors";

/**
 * Деньги в проекте — всегда целое число копеек: 390 рублей — это 39000.
 * Число с плавающей точкой для денег недопустимо: 0,1 + 0,2 ≠ 0,3.
 */
export type Kopecks = number;

export function assertMoney(value: number, field: string, allowNegative = false): void {
  if (!Number.isSafeInteger(value)) {
    throw new OrderRuleError(`${field}: сумма должна быть целым числом копеек`, { [field]: value });
  }
  if (!allowNegative && value < 0) {
    throw new OrderRuleError(`${field}: сумма не может быть отрицательной`, { [field]: value });
  }
}
