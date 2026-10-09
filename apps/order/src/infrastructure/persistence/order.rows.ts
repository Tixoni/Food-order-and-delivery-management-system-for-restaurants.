import type { SagaState } from "../../domain/checkout-saga";
import { Order, type OrderState } from "../../domain/order";
import { OrderLine } from "../../domain/order-line";
import type { CancelReason, OrderStatus } from "../../domain/order-status";
import type { OrderLineView, OrderView } from "../../application/ports/order-read-model";

/**
 * Строки таблиц заказа и их преобразование в домен и в представления.
 *
 * Запросы сервиса заказов написаны на SQL, а не построителем запросов ORM:
 * оптимистичная блокировка, вставка с конфликтом по частичному индексу
 * и аренда шагов саги — конструкции SQL, которые построитель выражает хуже
 * и прячет от читающего. Подключение и транзакции по-прежнему ведёт TypeORM.
 */

/** Точка как широта и долгота — без разбора GeoJSON на стороне приложения. */
export const ORDER_COLUMNS = `
  o.id, o.order_number, o.customer_id, o.restaurant_id, o.status,
  o.delivery_address_text,
  ST_Y(o.delivery_location::geometry) AS delivery_lat,
  ST_X(o.delivery_location::geometry) AS delivery_lon,
  ST_Y(o.pickup_location::geometry) AS pickup_lat,
  ST_X(o.pickup_location::geometry) AS pickup_lon,
  o.contact_phone, o.items_amount, o.delivery_fee, o.service_fee, o.discount_amount,
  o.total_amount, o.comment, o.expected_cooking_min, o.idempotency_key,
  o.placed_at, o.confirmed_at, o.ready_at, o.picked_up_at, o.delivered_at,
  o.cancelled_at, o.cancel_reason, o.cancel_comment, o.attention_reason, o.attention_at,
  o.version`;

export interface OrderRow {
  id: string;
  order_number: string;
  customer_id: string;
  restaurant_id: string;
  status: OrderStatus;
  delivery_address_text: string;
  delivery_lat: number;
  delivery_lon: number;
  pickup_lat: number | null;
  pickup_lon: number | null;
  contact_phone: string | null;
  items_amount: number;
  delivery_fee: number;
  service_fee: number;
  discount_amount: number;
  total_amount: number;
  comment: string | null;
  expected_cooking_min: number | null;
  idempotency_key: string;
  placed_at: Date;
  confirmed_at: Date | null;
  ready_at: Date | null;
  picked_up_at: Date | null;
  delivered_at: Date | null;
  cancelled_at: Date | null;
  cancel_reason: CancelReason | null;
  cancel_comment: string | null;
  attention_reason: string | null;
  attention_at: Date | null;
  version: number;
}

export interface ItemRow {
  id: string;
  order_id: string;
  position: number;
  menu_item_id: string;
  name_snapshot: string;
  price_snapshot: number;
  quantity: number;
  line_total: number;
}

export interface OptionRow {
  order_item_id: string;
  option_id: string;
  name_snapshot: string;
  price_delta_snapshot: number;
}

export interface SagaRow {
  id: string;
  order_id: string;
  current_step: string;
  state: { correlationId?: string; facts?: SagaState["facts"] } | null;
  status: SagaState["status"];
  version: number;
}

/** Позиции заказа с модификаторами, сгруппированные по заказу. */
export function groupLines(items: ItemRow[], options: OptionRow[]) {
  const optionsByItem = new Map<string, OptionRow[]>();
  for (const option of options) {
    const list = optionsByItem.get(option.order_item_id) ?? [];
    list.push(option);
    optionsByItem.set(option.order_item_id, list);
  }
  const byOrder = new Map<string, Array<{ item: ItemRow; options: OptionRow[] }>>();
  for (const item of [...items].sort((a, b) => a.position - b.position)) {
    const list = byOrder.get(item.order_id) ?? [];
    list.push({ item, options: optionsByItem.get(item.id) ?? [] });
    byOrder.set(item.order_id, list);
  }
  return byOrder;
}

export function toDomain(
  row: OrderRow,
  lines: Array<{ item: ItemRow; options: OptionRow[] }>,
): Order {
  const state: OrderState = {
    id: row.id,
    orderNumber: Number(row.order_number),
    customerId: row.customer_id,
    restaurantId: row.restaurant_id,
    status: row.status,
    addressText: row.delivery_address_text,
    location: { latitude: Number(row.delivery_lat), longitude: Number(row.delivery_lon) },
    pickup:
      row.pickup_lat === null || row.pickup_lon === null
        ? null
        : { latitude: Number(row.pickup_lat), longitude: Number(row.pickup_lon) },
    contactPhone: row.contact_phone,
    lines: lines.map(({ item, options }) =>
      OrderLine.create({
        menuItemId: item.menu_item_id,
        name: item.name_snapshot,
        basePrice: item.price_snapshot,
        quantity: item.quantity,
        options: options.map((option) => ({
          optionId: option.option_id,
          name: option.name_snapshot,
          priceDelta: option.price_delta_snapshot,
        })),
      }),
    ),
    amounts: {
      items: row.items_amount,
      delivery: row.delivery_fee,
      service: row.service_fee,
      discount: row.discount_amount,
      total: row.total_amount,
    },
    comment: row.comment,
    expectedCookingMin: row.expected_cooking_min,
    idempotencyKey: row.idempotency_key,
    placedAt: row.placed_at,
    confirmedAt: row.confirmed_at,
    readyAt: row.ready_at,
    pickedUpAt: row.picked_up_at,
    deliveredAt: row.delivered_at,
    cancelledAt: row.cancelled_at,
    cancelReason: row.cancel_reason,
    cancelComment: row.cancel_comment,
    attentionReason: row.attention_reason,
    attentionAt: row.attention_at,
    version: row.version,
  };
  return Order.restore(state);
}

export function sagaToDomain(row: SagaRow): SagaState {
  return {
    id: row.id,
    orderId: row.order_id,
    correlationId: row.state?.correlationId ?? row.id,
    status: row.status,
    currentStep: row.current_step,
    facts: (row.state?.facts ?? {}) as SagaState["facts"],
    version: row.version,
  };
}

const iso = (value: Date | null) => (value ? new Date(value).toISOString() : null);

/** Представление заказа для ответов: без телефона — он нужен только курьеру. */
export function toView(row: OrderRow, lines: Array<{ item: ItemRow; options: OptionRow[] }>) {
  const view: OrderView = {
    id: row.id,
    orderNumber: Number(row.order_number),
    customerId: row.customer_id,
    restaurantId: row.restaurant_id,
    status: row.status,
    addressText: row.delivery_address_text,
    location: { latitude: Number(row.delivery_lat), longitude: Number(row.delivery_lon) },
    comment: row.comment,
    amounts: {
      items: row.items_amount,
      delivery: row.delivery_fee,
      service: row.service_fee,
      discount: row.discount_amount,
      total: row.total_amount,
    },
    lines: lines.map(({ item, options }): OrderLineView => {
      const delta = options.reduce((sum, option) => sum + option.price_delta_snapshot, 0);
      return {
        menuItemId: item.menu_item_id,
        name: item.name_snapshot,
        quantity: item.quantity,
        unitPrice: item.price_snapshot + delta,
        lineTotal: item.line_total,
        options: options.map((option) => ({
          optionId: option.option_id,
          name: option.name_snapshot,
          priceDelta: option.price_delta_snapshot,
        })),
      };
    }),
    expectedCookingMin: row.expected_cooking_min,
    placedAt: iso(row.placed_at)!,
    confirmedAt: iso(row.confirmed_at),
    readyAt: iso(row.ready_at),
    pickedUpAt: iso(row.picked_up_at),
    deliveredAt: iso(row.delivered_at),
    cancelledAt: iso(row.cancelled_at),
    cancelReason: row.cancel_reason,
    cancelComment: row.cancel_comment,
    attention:
      row.attention_reason && row.attention_at
        ? { reason: row.attention_reason, at: iso(row.attention_at)! }
        : null,
  };
  return view;
}
