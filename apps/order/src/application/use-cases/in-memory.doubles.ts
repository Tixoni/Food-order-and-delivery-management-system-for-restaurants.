import { ConflictError, type DomainEvent } from "@food-delivery/shared";
import type {
  AuthorizePaymentRequest,
  AuthorizePaymentResponse,
  CapturePaymentRequest,
  RefundPaymentRequest,
  ReleaseCourierRequest,
  RequestCourierRequest,
  ValidateCartRequest,
  ValidateCartResponse,
  VoidPaymentRequest,
} from "@food-delivery/contracts";
import { CheckoutSaga, type SagaState } from "../../domain/checkout-saga";
import { Order, type OrderState, type StatusChange } from "../../domain/order";
import { DEFAULT_TIMEOUTS } from "../../domain/order-timeouts";
import type { Requester } from "../access";
import type { Cart, CartStore } from "../ports/cart.store";
import {
  ConcurrentModificationError,
  DuplicateMessageError,
  DuplicateOrderError,
  type LoadedOrder,
  type OrderChangeSet,
  type OrderRepository,
  type SagaStepRecord,
} from "../ports/order.repository";
import type { CatalogPort, DeliveryPort, PaymentPort } from "../ports/participants";
import type { ClaimedEntry, SagaQueue } from "../ports/saga-queue";
import { OrderCommitter } from "../saga/order-committer";
import { OrderWorkflow } from "../saga/order-workflow";
import { SagaRunner } from "../saga/saga-runner";
import type { SagaSettings } from "../saga/saga-settings";

/**
 * Тестовые дубли портов. Ведут себя как настоящая база там, где это важно
 * для проверяемых правил: версии (оптимистичная блокировка), уникальный ключ
 * идемпотентности, отметки обработанных сообщений, аренда шагов саги.
 */

interface StoredEntry {
  id: string;
  orderId: string;
  sagaId: string;
  type: string;
  fireAt: Date;
  firedAt: Date | null;
  attempts: number;
  lastError: string | null;
}

export class InMemoryOrderStore implements OrderRepository, SagaQueue {
  readonly orders = new Map<string, OrderState>();
  readonly sagas = new Map<string, SagaState>();
  readonly events: DomainEvent[] = [];
  readonly history: Array<StatusChange & { orderId: string }> = [];
  readonly entries: StoredEntry[] = [];
  readonly steps: SagaStepRecord[] = [];
  readonly inbox = new Set<string>();
  /** Текущее время «базы» для очереди: тест его двигает. */
  clock = new Date("2026-10-12T10:00:00Z");
  private numbers = 1000;
  private ids = 0;

  async nextOrderNumber() {
    this.numbers += 1;
    return this.numbers;
  }

  async findById(orderId: string): Promise<LoadedOrder | null> {
    const state = this.orders.get(orderId);
    const saga = [...this.sagas.values()].find((candidate) => candidate.orderId === orderId);
    if (!state || !saga) return null;
    return {
      order: Order.restore({ ...state, lines: [...state.lines] }),
      saga: CheckoutSaga.restore({ ...saga, facts: { ...saga.facts } }),
    };
  }

  async findByIdempotencyKey(customerId: string, key: string) {
    const state = [...this.orders.values()].find(
      (candidate) => candidate.customerId === customerId && candidate.idempotencyKey === key,
    );
    return state ? Order.restore({ ...state }) : null;
  }

  async create(change: OrderChangeSet) {
    const snapshot = change.order.snapshot();
    if (
      [...this.orders.values()].some(
        (o) => o.customerId === snapshot.customerId && o.idempotencyKey === snapshot.idempotencyKey,
      )
    ) {
      throw new DuplicateOrderError();
    }
    this.apply(change, true);
  }

  async save(change: OrderChangeSet) {
    const stored = this.orders.get(change.order.id);
    const storedSaga = this.sagas.get(change.saga.id);
    if (!stored || !storedSaga) throw new ConflictError("заказ не найден при сохранении");
    if (stored.version !== change.order.version || storedSaga.version !== change.saga.version) {
      throw new ConcurrentModificationError("заказ изменён одновременно");
    }
    if (change.inbox) {
      const key = `${change.inbox.consumer}:${change.inbox.messageId}`;
      if (this.inbox.has(key)) throw new DuplicateMessageError(change.inbox.messageId);
      this.inbox.add(key);
    }
    this.apply(change, false);
  }

  private apply(change: OrderChangeSet, created: boolean) {
    const orderVersion = created ? 1 : change.order.version + 1;
    const sagaVersion = created ? 1 : change.saga.version + 1;
    this.orders.set(change.order.id, { ...change.order.snapshot(), version: orderVersion });
    this.sagas.set(change.saga.id, { ...change.saga.snapshot(), version: sagaVersion });
    change.order.markPersisted(orderVersion);
    change.saga.markPersisted(sagaVersion);
    this.events.push(...change.events);
    this.history.push(...change.history.map((entry) => ({ ...entry, orderId: change.order.id })));
    this.steps.push(...(change.steps ?? []));

    const now = this.clock;
    if (change.completeEntryId) {
      const entry = this.entries.find((candidate) => candidate.id === change.completeEntryId);
      if (entry) entry.firedAt = now;
    }
    for (const type of change.cancel ?? []) {
      for (const entry of this.active(change.order.id, type)) entry.firedAt = now;
    }
    for (const scheduled of change.schedule ?? []) {
      const existing = this.active(change.order.id, scheduled.type)[0];
      if (existing) {
        existing.fireAt = scheduled.fireAt;
        existing.attempts = 0;
        existing.lastError = null;
      } else {
        this.ids += 1;
        this.entries.push({
          id: String(this.ids),
          orderId: change.order.id,
          sagaId: change.saga.id,
          type: scheduled.type,
          fireAt: scheduled.fireAt,
          firedAt: null,
          attempts: 0,
          lastError: null,
        });
      }
    }
  }

  /* ─────────────── SagaQueue ─────────────── */

  async claimDue(limit: number, leaseMs: number): Promise<ClaimedEntry[]> {
    const due = this.entries
      .filter((entry) => !entry.firedAt && entry.fireAt.getTime() <= this.clock.getTime())
      .sort((a, b) => a.fireAt.getTime() - b.fireAt.getTime())
      .slice(0, limit);
    return due.map((entry) => {
      entry.attempts += 1;
      entry.fireAt = new Date(this.clock.getTime() + leaseMs);
      return {
        id: entry.id,
        orderId: entry.orderId,
        sagaId: entry.sagaId,
        type: entry.type,
        attempt: entry.attempts,
      };
    });
  }

  async retryLater(entry: ClaimedEntry, fireAt: Date, error: string, step: SagaStepRecord) {
    const stored = this.entries.find((candidate) => candidate.id === entry.id)!;
    stored.fireAt = fireAt;
    stored.lastError = error;
    this.steps.push(step);
  }

  async discard(entry: ClaimedEntry) {
    const stored = this.entries.find((candidate) => candidate.id === entry.id);
    if (stored) stored.firedAt = this.clock;
  }

  /* ─────────────── Для проверок ─────────────── */

  active(orderId: string, type?: string) {
    return this.entries.filter(
      (entry) => entry.orderId === orderId && !entry.firedAt && (!type || entry.type === type),
    );
  }

  activeTypes(orderId: string): string[] {
    return this.active(orderId)
      .map((entry) => entry.type)
      .sort();
  }

  eventTypes(orderId?: string): string[] {
    return this.events
      .filter((event) => !orderId || event.aggregateId === orderId)
      .map((event) => event.eventType);
  }

  statusOf(orderId: string) {
    return this.orders.get(orderId)!.status;
  }

  sagaOf(orderId: string) {
    return [...this.sagas.values()].find((saga) => saga.orderId === orderId)!;
  }
}

/** Эмулятор платёжного сервиса: идемпотентен по ключу, умеет управляемые отказы. */
export class FakePayment implements PaymentPort {
  readonly calls: string[] = [];
  /** Операция → ошибка, которую бросать (или функция, решающая по номеру вызова). */
  failures = new Map<string, (call: number) => Error | null>();
  decline = false;
  private authorized = new Map<string, number>();
  private captured = new Map<string, number>();
  private responses = new Map<string, unknown>();
  private counters = new Map<string, number>();

  private run<T>(operation: string, key: string, action: () => T): T {
    this.calls.push(`${operation}:${key}`);
    const count = (this.counters.get(operation) ?? 0) + 1;
    this.counters.set(operation, count);
    const failure = this.failures.get(operation)?.(count);
    if (failure) throw failure;
    if (this.responses.has(key)) return this.responses.get(key) as T;
    const result = action();
    this.responses.set(key, result);
    return result;
  }

  async authorize(request: AuthorizePaymentRequest): Promise<AuthorizePaymentResponse> {
    return this.run("authorize", request.idempotencyKey, () => {
      if (this.decline)
        return {
          paymentId: `p-${request.orderId}`,
          status: "DECLINED" as const,
          declineReason: "недостаточно средств",
        };
      this.authorized.set(request.orderId, request.amount);
      return { paymentId: `p-${request.orderId}`, status: "AUTHORIZED" as const };
    });
  }

  async capture(request: CapturePaymentRequest) {
    return this.run("capture", request.idempotencyKey, () => {
      const amount = this.authorized.get(request.orderId);
      if (amount === undefined) throw new Error("нет холда");
      this.authorized.delete(request.orderId);
      this.captured.set(request.orderId, amount);
      return { paymentId: `p-${request.orderId}`, status: "CAPTURED" as const, amount };
    });
  }

  async void(request: VoidPaymentRequest) {
    return this.run("void", request.idempotencyKey, () => {
      const voided = this.authorized.delete(request.orderId);
      return { paymentId: voided ? `p-${request.orderId}` : null, voided };
    });
  }

  async refund(request: RefundPaymentRequest) {
    return this.run("refund", request.idempotencyKey, () => {
      const captured = this.captured.get(request.orderId) ?? 0;
      return {
        paymentId: `p-${request.orderId}`,
        status:
          request.amount >= captured ? ("REFUNDED" as const) : ("PARTIALLY_REFUNDED" as const),
        refundedTotal: request.amount,
      };
    });
  }

  /** Держит ли эмулятор деньги клиента: холд или списание без возврата. */
  holds(orderId: string) {
    return this.authorized.has(orderId);
  }
}

export class FakeDelivery implements DeliveryPort {
  readonly calls: string[] = [];
  failure: Error | null = null;

  async requestCourier(request: RequestCourierRequest) {
    this.calls.push(`request:${request.idempotencyKey}`);
    if (this.failure) throw this.failure;
    return { deliveryId: `d-${request.orderId}`, status: "PENDING" as const };
  }

  async releaseCourier(request: ReleaseCourierRequest) {
    this.calls.push(`release:${request.idempotencyKey}`);
    if (this.failure) throw this.failure;
    return { released: true };
  }
}

export const RESTAURANT_ID = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const ITEM_ID = "550e8400-e29b-41d4-a716-446655440000";

export class FakeCatalog implements CatalogPort {
  readonly calls: ValidateCartRequest[] = [];
  failure: Error | null = null;
  price = 45000;
  deliveryFee = 15000;

  async validateCart(
    restaurantId: string,
    request: ValidateCartRequest,
  ): Promise<ValidateCartResponse> {
    this.calls.push(request);
    if (this.failure) throw this.failure;
    const lines = request.items.map((item) => ({
      itemId: item.itemId,
      name: "Пицца «Маргарита»",
      basePrice: this.price,
      optionsDelta: 0,
      unitPrice: this.price,
      quantity: item.quantity,
      lineTotal: this.price * item.quantity,
      chosenOptions: [],
    }));
    const itemsAmount = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    return {
      restaurantId,
      zoneId: "zone-1",
      lines,
      itemsAmount,
      deliveryFee: this.deliveryFee,
      total: itemsAmount + this.deliveryFee,
      pickup: { latitude: 55.76, longitude: 37.62 },
      validatedAt: new Date().toISOString(),
    };
  }
}

export class InMemoryCartStore implements CartStore {
  readonly carts = new Map<string, Cart>();
  async get(customerId: string) {
    const cart = this.carts.get(customerId);
    return cart ? structuredClone(cart) : null;
  }
  async save(cart: Cart) {
    this.carts.set(cart.customerId, structuredClone(cart));
  }
  async clear(customerId: string) {
    this.carts.delete(customerId);
  }
}

export const TEST_SETTINGS: SagaSettings = {
  authorizeAttempts: 3,
  captureAttempts: 3,
  retryBaseMs: 1000,
  retryMaxMs: 30_000,
  attentionAfterAttempts: 3,
  courierRetryDelayMs: 60_000,
  serviceFee: 0,
  timeouts: DEFAULT_TIMEOUTS,
};

export const customer: Requester = {
  id: "a1b2c3d4-0000-4000-8000-000000000001",
  roles: ["client"],
};
export const kitchen: Requester = {
  id: "kitchen-user",
  roles: ["kitchen"],
  restaurantId: RESTAURANT_ID,
};
export const operator: Requester = { id: "operator-user", roles: ["operator"] };

/** Полный набор: хранилище, участники, исполнитель саги. */
export function buildWorld(settings: SagaSettings = TEST_SETTINGS) {
  const store = new InMemoryOrderStore();
  const payment = new FakePayment();
  const delivery = new FakeDelivery();
  const catalog = new FakeCatalog();
  const carts = new InMemoryCartStore();
  const workflow = new OrderWorkflow(settings.timeouts);
  const committer = new OrderCommitter(store, workflow);
  const runner = new SagaRunner(store, store, payment, delivery, workflow, committer, settings);

  /** Выполнить все наступившие шаги и таймеры, как фоновый планировщик. */
  const drain = async (rounds = 20) => {
    for (let round = 0; round < rounds; round += 1) {
      const claimed = await store.claimDue(50, 30_000);
      if (claimed.length === 0) return;
      for (const entry of claimed) await runner.run(entry, store.clock);
    }
  };
  /** Сдвинуть время вперёд и выполнить всё, что наступило. */
  const advance = async (ms: number) => {
    store.clock = new Date(store.clock.getTime() + ms);
    await drain();
  };

  return {
    store,
    payment,
    delivery,
    catalog,
    carts,
    workflow,
    committer,
    runner,
    drain,
    advance,
    settings,
  };
}
