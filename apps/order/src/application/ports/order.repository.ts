import { ConflictError, type DomainEvent } from "@food-delivery/shared";
import type { CheckoutSaga } from "../../domain/checkout-saga";
import type { Order, StatusChange } from "../../domain/order";

/** Отложенный шаг или таймер саги. */
export interface ScheduledEntry {
  /** Имя шага (`AUTHORIZE_PAYMENT`) или таймера (`TIMEOUT:COOKING`). */
  type: string;
  fireAt: Date;
}

/** Запись о попытке шага саги — для истории заказа (REL-5). */
export interface SagaStepRecord {
  step: string;
  isCompensation: boolean;
  status: "SUCCEEDED" | "FAILED";
  attempt: number;
  request?: unknown;
  response?: unknown;
  error?: string;
  startedAt: Date;
  finishedAt: Date;
}

/** Отметка об обработанном сообщении брокера (REL-4). */
export interface InboxMarker {
  messageId: string;
  consumer: string;
  eventType: string;
}

/**
 * Всё, что должно попасть в базу вместе или не попасть вовсе.
 *
 * Порт принимает изменение одним объектом — правило проекта «одна
 * транзакция — один вызов порта». Иначе сценарий мог бы сохранить заказ,
 * а событие о нём — потерять при сбое между двумя вызовами (REL-3).
 */
export interface OrderChangeSet {
  order: Order;
  saga: CheckoutSaga;
  /** Переходы статуса — в историю заказа (ADM-3). */
  history: readonly StatusChange[];
  events: readonly DomainEvent[];
  /** Новые шаги и таймеры. Активная запись того же типа заменяется. */
  schedule?: readonly ScheduledEntry[];
  /** Снять активные записи этих типов: шаг потерял смысл, срок статуса больше не нужен. */
  cancel?: readonly string[];
  /** Шаг, выполнение которого завершено этой транзакцией. */
  completeEntryId?: string;
  steps?: readonly SagaStepRecord[];
  /** Сообщение брокера, обработка которого фиксируется этой транзакцией. */
  inbox?: InboxMarker;
}

export interface LoadedOrder {
  order: Order;
  saga: CheckoutSaga;
}

/**
 * Хранилище заказов.
 *
 * Ошибки, которые сценарий обязан различать:
 *   DuplicateOrderError   — заказ с этим ключом идемпотентности уже есть (ORD-4);
 *   ConflictError         — версия изменилась: заказ одновременно изменили (гонка);
 *   DuplicateMessageError — сообщение брокера уже обработано (REL-4).
 */
export interface OrderRepository {
  /** Номер заказа для людей — из последовательности базы, до создания заказа. */
  nextOrderNumber(): Promise<number>;
  findById(orderId: string): Promise<LoadedOrder | null>;
  findByIdempotencyKey(customerId: string, key: string): Promise<Order | null>;
  /** Новый заказ вместе с сагой, событиями и первыми шагами. */
  create(change: OrderChangeSet): Promise<void>;
  /** Изменение существующего заказа с проверкой версий заказа и саги. */
  save(change: OrderChangeSet): Promise<void>;
}

export const ORDER_REPOSITORY = Symbol("OrderRepository");

/**
 * Заказ или сага изменены другой записью между чтением и сохранением
 * (оптимистичная блокировка). Отдельный класс, а не просто конфликт:
 * команду людей в этом случае имеет смысл перечитать и применить заново —
 * вторая запись могла быть служебной (отметка о холде из события платежей),
 * и для клиента это не повод получить ошибку.
 */
export class ConcurrentModificationError extends ConflictError {}

export class DuplicateOrderError extends Error {
  constructor() {
    super("заказ с этим ключом идемпотентности уже существует");
    this.name = "DuplicateOrderError";
  }
}

export class DuplicateMessageError extends Error {
  constructor(readonly messageId: string) {
    super(`сообщение ${messageId} уже обработано`);
    this.name = "DuplicateMessageError";
  }
}
