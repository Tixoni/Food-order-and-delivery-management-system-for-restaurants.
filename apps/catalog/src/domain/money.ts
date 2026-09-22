/**
 * Деньги в проекте — всегда целое число копеек.
 *
 * 390 рублей записываются как 39000.
 *
 * `Kopecks` — alias для `number`, а не отдельный номинальный тип: при
 * структурной типизации TypeScript псевдоним ничего не сужает и не
 * защищает от передачи произвольного числа туда, где ожидается сумма.
 * Он служит документацией параметра, а не гарантией компилятора.
 *
 * Branded-тип (`number & { readonly brand: unique symbol }`) здесь
 * сознательно не сделан. Деньги участвуют в арифметике — сложение цены
 * и надбавок модификаторов в `calculatePrice`, — а любая арифметическая
 * операция над branded-числом возвращает обычный `number`: бренд не
 * переживает `+`. Пришлось бы расставлять приведения типа именно
 * в расчёте цены — там, где правильность уже покрыта тестами, —
 * а не там, где реально возможна ошибка (необработанное число на входе
 * в create()). Для идентификаторов (RestaurantId, OrderId) бренд был бы
 * уместен: их не складывают и не умножают, этой проблемы там нет.
 *
 * Настоящая защита — не тип, а приватный конструктор: `MenuItem.create()`
 * и подобные фабрики — единственный способ получить экземпляр, и внутри
 * них `assertMoney` бросает исключение на недопустимом значении.
 */
export type Kopecks = number;

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

export interface MoneyOptions {
  /** Разрешает отрицательное денежное значение, например для скидки или корректировки. */
  allowNegative?: boolean;
}

/**
 * Проверяет, что значение — корректная сумма в копейках, и бросает
 * MoneyError, если нет.
 *
 * Возвращает void, а не `asserts value is Kopecks`: раз Kopecks — просто
 * alias number, такая assertion-сигнатура не сужала бы ничего сверх того,
 * что уже известно, и вводила бы читателя в заблуждение, будто после
 * вызова компилятор что-то гарантирует. Гарантия — рантайм-проверка ниже.
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
