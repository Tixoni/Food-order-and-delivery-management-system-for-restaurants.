import type { DomainEvent } from "@food-delivery/shared";
import type { Kopecks } from "../../domain/money";
import type { OperationPlan, OperationType, Payment, PaymentState } from "../../domain/payment";

/**
 * Хранилище платежей и журнала операций.
 *
 * Порядок работы с операцией — ради PAY-4 и ради того, чтобы транзакция
 * базы не оставалась открытой на время сетевого вызова:
 *   1. `start…` — запись операции со статусом PENDING под уникальным ключом;
 *      ключ уже известен — возвращается прежняя запись;
 *   2. вызов провайдера — вне транзакции, с тем же ключом;
 *   3. `finish` — итог, новое состояние платежа и событие одной транзакцией,
 *      и только если запись ещё PENDING: при одновременных повторах итог
 *      фиксирует ровно один из них.
 */

export type TransactionStatus = "PENDING" | "SUCCEEDED" | "FAILED";

/**
 * Сохранённый итог операции — то, что получит повтор с тем же ключом.
 * `result` — ответ по контракту; `rejected` — отказ по существу (текст ошибки).
 */
export type StoredOutcome = { result: unknown } | { rejected: string };

/** Параметры, с которыми операция ушла провайдеру: нужны, чтобы довести её после сбоя. */
export interface OperationRequest {
  amount: Kopecks;
  correlationId: string;
}

export interface TransactionRecord {
  id: string;
  paymentId: string;
  type: OperationType;
  amount: Kopecks;
  status: TransactionStatus;
  idempotencyKey: string;
  request: OperationRequest;
  outcome: StoredOutcome | null;
  providerRef: string | null;
  errorCode: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export interface StartedOperation {
  payment: Payment;
  transaction: TransactionRecord;
}

export interface Completion {
  status: Exclude<TransactionStatus, "PENDING">;
  outcome: StoredOutcome;
  providerRef?: string | null;
  errorCode?: string | null;
  events: DomainEvent[];
}

export interface PaymentHistory {
  payments: PaymentState[];
  transactions: TransactionRecord[];
}

export interface PaymentRepository {
  /** Новый платёж и запись холда по ключу — или уже существующие с этим ключом. */
  startAuthorization(input: {
    orderId: string;
    customerId: string;
    amount: Kopecks;
    idempotencyKey: string;
    correlationId: string;
  }): Promise<StartedOperation>;

  /**
   * Операция над последним платежом заказа, под его блокировкой.
   * Ключ уже известен — прежняя запись, `plan` не вызывается. Иначе `plan`
   * решает, можно ли начать; `null` — пустая операция, запись не создаётся.
   */
  startOperation(
    orderId: string,
    idempotencyKey: string,
    correlationId: string,
    plan: (payment: Payment) => OperationPlan | null,
  ): Promise<StartedOperation | { payment: Payment | null; transaction: null }>;

  /**
   * Итог операции. `complete` меняет платёж и возвращает итог; всё
   * фиксируется одной транзакцией. Запись уже завершена другим процессом —
   * она и возвращается, `complete` не вызывается.
   */
  finish(
    transactionId: string,
    complete: (payment: Payment, transaction: TransactionRecord) => Completion,
  ): Promise<TransactionRecord>;

  /** Последний платёж заказа и его незавершённые операции; `null` — платежа нет. */
  openOperations(
    orderId: string,
  ): Promise<{ payment: Payment; transactions: TransactionRecord[] } | null>;

  /**
   * Незавершённые операции для сверки: старше `olderThanMs`, но моложе
   * `youngerThanMs`. Возраст считается по часам базы — тем же, что
   * проставили время создания: часы процесса и базы могут расходиться.
   */
  pending(olderThanMs: number, youngerThanMs: number, limit: number): Promise<StartedOperation[]>;

  /** Вся денежная история заказа — одним запросом. */
  history(orderId: string): Promise<PaymentHistory>;
}

export const PAYMENT_REPOSITORY = Symbol("PaymentRepository");
