import type { GeoPoint } from "./geo-point";
import { assertMoney, type Kopecks } from "./money";
import { InvalidTransitionError, OrderRuleError } from "./order-errors";
import { OrderLine } from "./order-line";
import {
  CANCEL_REASONS_BY_ACTOR,
  TERMINAL_STATUSES,
  isTransitionAllowed,
  type ActorType,
  type CancelReason,
  type OrderStatus,
} from "./order-status";

export interface Actor {
  type: ActorType;
  /** Пользователь или курьер; у системы — null. */
  id: string | null;
}

export const SYSTEM: Actor = { type: "SYSTEM", id: null };

/** Запись о переходе статуса: попадает в историю (ADM-3) и становится событием. */
export interface StatusChange {
  readonly from: OrderStatus | null;
  readonly to: OrderStatus;
  readonly actor: Actor;
  readonly reason: string | null;
  readonly at: Date;
}

export interface OrderAmounts {
  readonly items: Kopecks;
  readonly delivery: Kopecks;
  readonly service: Kopecks;
  readonly discount: Kopecks;
  readonly total: Kopecks;
}

export interface OrderState {
  id: string;
  orderNumber: number;
  customerId: string;
  restaurantId: string;
  status: OrderStatus;
  addressText: string;
  location: GeoPoint;
  pickup: GeoPoint | null;
  contactPhone: string | null;
  lines: OrderLine[];
  amounts: OrderAmounts;
  comment: string | null;
  expectedCookingMin: number | null;
  idempotencyKey: string;
  placedAt: Date;
  confirmedAt: Date | null;
  readyAt: Date | null;
  pickedUpAt: Date | null;
  deliveredAt: Date | null;
  cancelledAt: Date | null;
  cancelReason: CancelReason | null;
  cancelComment: string | null;
  attentionReason: string | null;
  attentionAt: Date | null;
  version: number;
}

export interface PlaceOrderProps {
  id: string;
  /** Номер берётся из последовательности базы до создания: он нужен событиям. */
  orderNumber: number;
  customerId: string;
  restaurantId: string;
  idempotencyKey: string;
  addressText: string;
  location: GeoPoint;
  pickup: GeoPoint | null;
  contactPhone: string | null;
  lines: OrderLine[];
  deliveryFee: Kopecks;
  serviceFee: Kopecks;
  comment: string | null;
}

const MAX_COOKING_MINUTES = 180;

/**
 * Агрегат «Заказ»: заказ, позиции и история переходов меняются целиком,
 * одной транзакцией.
 *
 * Все изменения статуса идут через один метод `move`, который сверяется
 * с таблицей переходов. Каждый переход записывается в список изменений:
 * из него слой сценариев строит историю и события. Поэтому история
 * и события не могут разойтись с фактическим статусом.
 *
 * Команды, повторённые после успеха, ничего не меняют и не считаются
 * ошибкой: кухня, нажавшая «принять» дважды, получает тот же заказ,
 * а не «недопустимый переход».
 */
export class Order {
  private readonly changes: StatusChange[] = [];

  private constructor(private readonly state: OrderState) {}

  static place(props: PlaceOrderProps, at: Date): Order {
    if (props.lines.length === 0) throw new OrderRuleError("в заказе нет позиций");
    if (!props.idempotencyKey?.trim() || props.idempotencyKey.length > 100) {
      throw new OrderRuleError("ключ идемпотентности обязателен и не длиннее 100 символов");
    }
    const addressText = props.addressText?.trim();
    if (!addressText) throw new OrderRuleError("не указан адрес доставки");
    if (addressText.length > 500) throw new OrderRuleError("адрес длиннее 500 символов");
    if (props.comment && props.comment.length > 1000) {
      throw new OrderRuleError("комментарий длиннее 1000 символов");
    }
    assertMoney(props.deliveryFee, "deliveryFee");
    assertMoney(props.serviceFee, "serviceFee");

    // Итог считает только сервер: сумма, пришедшая от клиента, не принимается.
    const items = props.lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const total = items + props.deliveryFee + props.serviceFee;
    assertMoney(total, "total");
    if (total <= 0) throw new OrderRuleError("сумма заказа должна быть больше нуля");

    const order = new Order({
      id: props.id,
      orderNumber: props.orderNumber,
      customerId: props.customerId,
      restaurantId: props.restaurantId,
      status: "CREATED",
      addressText,
      location: props.location,
      pickup: props.pickup,
      contactPhone: props.contactPhone?.trim() || null,
      lines: [...props.lines],
      amounts: {
        items,
        delivery: props.deliveryFee,
        service: props.serviceFee,
        discount: 0,
        total,
      },
      comment: props.comment?.trim() || null,
      expectedCookingMin: null,
      idempotencyKey: props.idempotencyKey,
      placedAt: at,
      confirmedAt: null,
      readyAt: null,
      pickedUpAt: null,
      deliveredAt: null,
      cancelledAt: null,
      cancelReason: null,
      cancelComment: null,
      attentionReason: null,
      attentionAt: null,
      version: 0,
    });
    order.changes.push({
      from: null,
      to: "CREATED",
      actor: { type: "CUSTOMER", id: props.customerId },
      reason: null,
      at,
    });
    return order;
  }

  /** Восстановление из хранилища: правила уже проверены при создании. */
  static restore(state: OrderState): Order {
    return new Order({ ...state, lines: [...state.lines] });
  }

  get id() {
    return this.state.id;
  }
  get orderNumber() {
    return this.state.orderNumber;
  }
  get customerId() {
    return this.state.customerId;
  }
  get restaurantId() {
    return this.state.restaurantId;
  }
  get status() {
    return this.state.status;
  }
  get version() {
    return this.state.version;
  }
  get isTerminal() {
    return TERMINAL_STATUSES.has(this.state.status);
  }
  get amounts() {
    return this.state.amounts;
  }
  get lines(): readonly OrderLine[] {
    return this.state.lines;
  }
  get location() {
    return this.state.location;
  }
  get pickup() {
    return this.state.pickup;
  }
  get expectedCookingMin() {
    return this.state.expectedCookingMin;
  }
  get confirmedAt() {
    return this.state.confirmedAt;
  }
  get cancelReason() {
    return this.state.cancelReason;
  }
  get attentionReason() {
    return this.state.attentionReason;
  }

  /** Снимок состояния для хранилища и ответов. */
  snapshot(): Readonly<OrderState> {
    return { ...this.state, lines: [...this.state.lines] };
  }

  /** Переходы, накопленные с момента загрузки. Забираются один раз — при сохранении. */
  pullChanges(): StatusChange[] {
    return this.changes.splice(0, this.changes.length);
  }

  /** После сохранения: версия растёт с каждой записью. */
  markPersisted(version: number): void {
    this.state.version = version;
  }

  /* ─────────────── Команды ─────────────── */

  /** Сага начала холдирование средств. */
  startPayment(at: Date): boolean {
    if (this.state.status === "PENDING_PAYMENT") return false;
    this.move("PENDING_PAYMENT", SYSTEM, at);
    return true;
  }

  /**
   * Средства захолдированы: заказ оплачен и сразу отправлен ресторану.
   * PAID — переходный статус, заказ в нём не задерживается.
   */
  markPaid(at: Date): boolean {
    if (this.state.status === "AWAITING_RESTAURANT") return false;
    this.move("PAID", SYSTEM, at);
    this.move("AWAITING_RESTAURANT", SYSTEM, at);
    return true;
  }

  /** KIT-2: ресторан принял заказ и назвал время готовки. */
  confirm(cookingMinutes: number, actor: Actor, at: Date): boolean {
    if (this.state.status === "COOKING") return false;
    if (
      !Number.isInteger(cookingMinutes) ||
      cookingMinutes < 1 ||
      cookingMinutes > MAX_COOKING_MINUTES
    ) {
      throw new OrderRuleError(
        `время готовки должно быть целым числом минут от 1 до ${MAX_COOKING_MINUTES}`,
      );
    }
    this.move("COOKING", actor, at);
    this.state.expectedCookingMin = cookingMinutes;
    this.state.confirmedAt = at;
    return true;
  }

  /**
   * KIT-4: заказ готов к выдаче. READY — переходный статус: подбор курьера
   * уже идёт, заказ сразу ждёт его приёма.
   */
  markReady(actor: Actor, at: Date, reason: string | null = null): boolean {
    if (this.state.status === "ASSIGNING_COURIER") return false;
    this.move("READY", actor, at, reason);
    this.state.readyAt = at;
    this.move("ASSIGNING_COURIER", SYSTEM, at);
    return true;
  }

  /**
   * Курьер забрал заказ. Если кухня забыла отметить готовность —
   * готовность отмечается автоматически: факт вручения сильнее кнопки.
   */
  pickUp(courierId: string, at: Date): boolean {
    if (this.state.status === "IN_TRANSIT") return false;
    if (this.state.status === "COOKING") {
      this.markReady(SYSTEM, at, "курьер забрал заказ до отметки о готовности");
    }
    this.move("IN_TRANSIT", { type: "COURIER", id: courierId }, at);
    this.state.pickedUpAt = at;
    return true;
  }

  deliver(courierId: string, at: Date): boolean {
    if (this.state.status === "DELIVERED") return false;
    this.move("DELIVERED", { type: "COURIER", id: courierId }, at);
    this.state.deliveredAt = at;
    this.clearAttention();
    return true;
  }

  /**
   * Отмена. Кто и на каком этапе вправе отменить, решает таблица переходов;
   * какую причину вправе назвать — правило по актору. Возврат средств
   * запускает сага: заказ не знает, как устроены платежи.
   */
  cancel(actor: Actor, reason: CancelReason, comment: string | null, at: Date): boolean {
    if (this.state.status === "CANCELLED") return false;
    if (!CANCEL_REASONS_BY_ACTOR[actor.type].includes(reason)) {
      throw new OrderRuleError(`${actor.type} не может отменить заказ с причиной ${reason}`);
    }
    if (comment && comment.length > 500) throw new OrderRuleError("причина длиннее 500 символов");
    this.move("CANCELLED", actor, at, comment);
    this.state.cancelledAt = at;
    this.state.cancelReason = reason;
    this.state.cancelComment = comment?.trim() || null;
    this.clearAttention();
    return true;
  }

  /** Истёк срок без автоматического решения — заказ в очереди оператора. */
  flagAttention(reason: string, at: Date): void {
    if (this.isTerminal) return;
    this.state.attentionReason = reason.slice(0, 200);
    this.state.attentionAt = at;
  }

  clearAttention(): void {
    this.state.attentionReason = null;
    this.state.attentionAt = null;
  }

  private move(to: OrderStatus, actor: Actor, at: Date, reason: string | null = null): void {
    const from = this.state.status;
    if (!isTransitionAllowed(from, to, actor.type)) {
      throw new InvalidTransitionError(from, to, actor.type);
    }
    this.state.status = to;
    this.changes.push({ from, to, actor, reason, at });
  }
}
