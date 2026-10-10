import { PaymentRuleError } from "./payment-errors";

/**
 * Деньги внутри системы — целое число копеек: 390 рублей — это 39000.
 *
 * Провайдер (контракт ЮKassa) принимает и возвращает сумму строкой в рублях
 * с двумя знаками: `"390.00"`. Перевод — только строковыми и целочисленными
 * операциями: `Math.round(390.1 * 100)` даёт верный ответ не всегда, а на
 * длинной истории частичных возвратов копейки расходятся.
 */
export type Kopecks = number;

export function assertAmount(value: number, field = "amount"): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new PaymentRuleError(`${field}: сумма должна быть целым положительным числом копеек`, {
      [field]: value,
    });
  }
}

/** 39050 → `"390.50"`. */
export function toProviderValue(kopecks: Kopecks): string {
  assertAmount(kopecks);
  const rubles = Math.floor(kopecks / 100);
  const rest = kopecks % 100;
  return `${rubles}.${rest.toString().padStart(2, "0")}`;
}

const PROVIDER_VALUE = /^(\d{1,12})(?:\.(\d{1,2}))?$/;

/** `"390.5"` → 39050. Строка неверного вида — ошибка, а не «примерно столько». */
export function fromProviderValue(value: string): Kopecks {
  const match = PROVIDER_VALUE.exec(value.trim());
  if (!match) {
    throw new PaymentRuleError("провайдер вернул сумму неверного вида", { value });
  }
  const [, rubles, fraction = ""] = match;
  return Number(rubles) * 100 + Number(fraction.padEnd(2, "0"));
}
