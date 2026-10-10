import type { Kopecks } from "../../domain/money";

/**
 * Платёжный провайдер — за портом (Anti-corruption layer).
 *
 * Модель провайдера (строковые суммы в рублях, его статусы и коды отказов)
 * сюда не протекает: сценарии видят только «холд прошёл / отклонён»,
 * «списано», «возвращено». Замена эмулятора боевым эквайрингом меняет
 * адаптер, а не сценарии.
 *
 * Каждый вызов несёт ключ идемпотентности — тот же, что пришёл от `order`.
 * Повтор с тем же ключом провайдер узнаёт и не двигает деньги второй раз.
 */

export interface HoldRequest {
  orderId: string;
  amount: Kopecks;
  currency: "RUB";
  idempotencyKey: string;
}

export interface HoldResult {
  providerPaymentId: string;
  /** Ложь — банк отказал: штатный исход, а не сбой. */
  held: boolean;
  declineReason?: string;
}

export interface ProviderOperation {
  providerPaymentId: string;
  idempotencyKey: string;
}

/** Фактическое состояние платежа у провайдера — для сверки незавершённых операций. */
export interface ProviderPaymentStatus {
  status: "pending" | "waiting_for_capture" | "succeeded" | "canceled";
  refundedAmount: Kopecks;
}

export interface PaymentProvider {
  hold(request: HoldRequest): Promise<HoldResult>;
  capture(request: ProviderOperation & { amount: Kopecks }): Promise<void>;
  cancel(request: ProviderOperation): Promise<void>;
  refund(request: ProviderOperation & { amount: Kopecks }): Promise<{ refundId: string }>;
  /** Только чтение: ничего не двигает, поэтому безопасно при любой неясности. */
  status(providerPaymentId: string): Promise<ProviderPaymentStatus>;
}

export const PAYMENT_PROVIDER = Symbol("PaymentProvider");

/**
 * Провайдер отказался выполнить операцию по существу: платёж уже отменён,
 * возврат больше списанного. Повтор ответа не изменит — в отличие от сбоя
 * связи, который адаптер сообщает ошибкой внешнего сервиса.
 */
export class ProviderRejectedError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "ProviderRejectedError";
  }
}
