import type { SagaStepRecord } from "./order.repository";

/** Шаг или таймер, взятый в работу. */
export interface ClaimedEntry {
  id: string;
  orderId: string;
  sagaId: string;
  type: string;
  /** Номер попытки, включая текущую. */
  attempt: number;
}

/**
 * Очередь отложенных шагов и таймеров саги поверх базы.
 *
 * Запись берётся в работу «в аренду»: её срок отодвигается на время аренды.
 * Если процесс упадёт посреди шага, аренда истечёт и запись возьмут снова —
 * шаг повторится с тем же ключом идемпотентности. Так шаг саги переживает
 * перезапуск сервиса, а две реплики не выполняют один шаг одновременно.
 */
export interface SagaQueue {
  claimDue(limit: number, leaseMs: number): Promise<ClaimedEntry[]>;
  /** Шаг не удался, но повторить имеет смысл: запись остаётся активной до `fireAt`. */
  retryLater(entry: ClaimedEntry, fireAt: Date, error: string, step: SagaStepRecord): Promise<void>;
  /** Запись потеряла смысл (заказ удалён, шаг уже не нужен) — снять без изменений заказа. */
  discard(entry: ClaimedEntry, reason: string): Promise<void>;
}

export const SAGA_QUEUE = Symbol("SagaQueue");
