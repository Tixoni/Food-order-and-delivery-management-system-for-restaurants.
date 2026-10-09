import type { StatusTimeouts } from "../../domain/order-timeouts";

/**
 * Настройки исполнения саги. Значения по умолчанию — в конфигурации сервиса;
 * здесь только их смысл.
 */
export interface SagaSettings {
  /**
   * Сколько попыток холдирования до отмены заказа. Вместе с задержками
   * это ~30 с: клиент не ждёт оплату десять минут, а система приходит
   * в согласованное состояние в пределах REL-5 (≤ 60 с).
   */
  authorizeAttempts: number;
  /** Сколько попыток списания до компенсации (отзыв у ресторана, снятие холда). */
  captureAttempts: number;
  /** Задержка повтора шага: начальная и потолок. */
  retryBaseMs: number;
  retryMaxMs: number;
  /**
   * После скольких неудачных попыток компенсации или вызова курьера звать
   * оператора. Сами попытки не прекращаются: деньги обязаны вернуться.
   */
  attentionAfterAttempts: number;
  /** Пауза перед повторным вызовом курьера, если свободных рядом нет. */
  courierRetryDelayMs: number;
  /** Сервисный сбор, копейки (CART-2). */
  serviceFee: number;
  timeouts: StatusTimeouts;
}

export const SAGA_SETTINGS = Symbol("SagaSettings");
