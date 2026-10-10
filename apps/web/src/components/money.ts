/**
 * Деньги в приложении — те же целые копейки, что и в сервисах.
 *
 * Перевод в рубли выполняется только при показе. Хранить и считать
 * дробными числами нельзя: 0.1 + 0.2 в двоичной дроби не равно 0.3,
 * и на длинном чеке расхождение доходит до копеек, которых никто
 * не может объяснить.
 */

export function formatMoney(kopecks: number): string {
  const sign = kopecks < 0 ? "−" : "";
  const abs = Math.abs(kopecks);
  const roubles = Math.trunc(abs / 100).toLocaleString("ru-RU");
  const rest = String(abs % 100).padStart(2, "0");

  return `${sign}${roubles},${rest} ₽`;
}

/** Ввод суммы человеком: «390», «390,50» и «390.50» означают одно и то же. */
export function parseMoney(input: string): number | null {
  const normalized = input.trim().replace(/\s/g, "").replace(",", ".");
  if (normalized === "") return null;

  const value = Number(normalized);
  if (!Number.isFinite(value) || value < 0) return null;

  return Math.round(value * 100);
}

/** Минуты словами: «25 минут», «21 минута», «43 минуты». */
export function formatMinutes(minutes: number): string {
  const lastTwo = minutes % 100;
  const last = minutes % 10;

  if (lastTwo >= 11 && lastTwo <= 14) return `${minutes} минут`;
  if (last === 1) return `${minutes} минута`;
  if (last >= 2 && last <= 4) return `${minutes} минуты`;

  return `${minutes} минут`;
}

/** Надбавка модификатора: может быть и скидкой — «-50» означает минус 50 ₽. */
export function parseSignedMoney(input: string): number | null {
  const trimmed = input.trim().replace(/\s/g, "").replace("−", "-");
  const negative = trimmed.startsWith("-");
  const value = parseMoney(negative ? trimmed.slice(1) : trimmed.replace(/^\+/, ""));
  return value === null ? null : negative ? -value : value;
}

/** Копейки в строку для поля ввода: 39000 → «390», 39050 → «390,50». */
export function moneyInput(kopecks: number): string {
  const sign = kopecks < 0 ? "-" : "";
  const abs = Math.abs(kopecks);
  const rest = abs % 100;
  return `${sign}${Math.trunc(abs / 100)}${rest ? `,${String(rest).padStart(2, "0")}` : ""}`;
}

/** Стоимость доставки словами: бесплатная доставка — не «0,00 ₽». */
export function formatDelivery(kopecks: number): string {
  return kopecks === 0 ? "доставка бесплатно" : `доставка ${formatMoney(kopecks)}`;
}
