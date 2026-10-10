/**
 * Статусы заказа глазами клиента.
 *
 * Сервис заказов различает восемь рабочих статусов, клиенту столько
 * не нужно: «оплачен» и «ждёт ресторан» для него одно и то же —
 * «ждём подтверждения». Поэтому на экране — пять шагов, а не восемь.
 * Подписи живут здесь, в клиентском приложении: шлюз отдаёт код
 * статуса, а кухне и курьеру те же статусы подписываются иначе.
 */

export interface ClientStep {
  key: string;
  title: string;
  statuses: string[];
}

export const CLIENT_STEPS: ClientStep[] = [
  { key: "payment", title: "Оплата", statuses: ["CREATED", "PENDING_PAYMENT"] },
  { key: "restaurant", title: "Ресторан подтверждает", statuses: ["PAID", "AWAITING_RESTAURANT"] },
  { key: "cooking", title: "Готовится", statuses: ["COOKING"] },
  { key: "courier", title: "Ищем курьера", statuses: ["READY", "ASSIGNING_COURIER"] },
  { key: "transit", title: "В пути", statuses: ["IN_TRANSIT"] },
  { key: "delivered", title: "Доставлен", statuses: ["DELIVERED"] },
];

const STATUS_TEXT: Record<string, string> = {
  CREATED: "Оформлен",
  PENDING_PAYMENT: "Проводим оплату",
  PAID: "Оплачен, ждём ресторан",
  AWAITING_RESTAURANT: "Ресторан подтверждает",
  COOKING: "Готовится",
  READY: "Готов, ищем курьера",
  ASSIGNING_COURIER: "Ищем курьера",
  IN_TRANSIT: "Курьер в пути",
  DELIVERED: "Доставлен",
  CANCELLED: "Отменён",
};

const CANCEL_TEXT: Record<string, string> = {
  CUSTOMER: "Вы отменили заказ",
  RESTAURANT: "Ресторан не смог принять заказ",
  TIMEOUT: "Ресторан не ответил вовремя",
  OPERATOR: "Заказ отменила поддержка",
  TECHNICAL: "Технический сбой",
  PAYMENT_FAILED: "Оплата не прошла",
};

export function statusText(status: string): string {
  return STATUS_TEXT[status] ?? status;
}

export function cancelText(reason: string | null): string {
  return reason ? (CANCEL_TEXT[reason] ?? "Заказ отменён") : "Заказ отменён";
}

/** Номер шага клиента; −1 — отменён. */
export function stepIndex(status: string): number {
  return CLIENT_STEPS.findIndex((step) => step.statuses.includes(status));
}

export function isFinished(status: string): boolean {
  return status === "DELIVERED" || status === "CANCELLED";
}

/** «10 окт., 14:05» — время в часовом поясе клиента. */
export function formatTime(iso: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleString("ru-RU", {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  });
}
