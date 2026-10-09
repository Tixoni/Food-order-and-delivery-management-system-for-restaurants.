/**
 * Сторона чтения (облегчённый CQRS).
 *
 * Очередь кухни, история заказов клиента и экран оператора — простые
 * выборки. Гонять их через агрегат и полную загрузку саги неэффективно,
 * поэтому они идут отдельным портом, возвращающим готовые представления.
 * Команды при этом по-прежнему проходят только через агрегат.
 */

export interface OrderLineView {
  menuItemId: string;
  name: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  options: Array<{ optionId: string; name: string; priceDelta: number }>;
}

export interface OrderView {
  id: string;
  orderNumber: number;
  customerId: string;
  restaurantId: string;
  status: string;
  addressText: string;
  location: { latitude: number; longitude: number };
  comment: string | null;
  amounts: { items: number; delivery: number; service: number; discount: number; total: number };
  lines: OrderLineView[];
  expectedCookingMin: number | null;
  placedAt: string;
  confirmedAt: string | null;
  readyAt: string | null;
  pickedUpAt: string | null;
  deliveredAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  cancelComment: string | null;
  attention: { reason: string; at: string } | null;
}

export interface StatusHistoryView {
  from: string | null;
  to: string;
  actorType: string;
  actorId: string | null;
  reason: string | null;
  at: string;
}

export interface SagaStepView {
  step: string;
  isCompensation: boolean;
  status: string;
  attempt: number;
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
}

export interface OrderHistoryView {
  orderId: string;
  transitions: StatusHistoryView[];
  saga: { status: string; currentStep: string; facts: unknown; steps: SagaStepView[] } | null;
  pending: Array<{ type: string; fireAt: string; attempts: number; lastError: string | null }>;
}

export interface OrderListFilter {
  statuses?: string[];
  attentionOnly?: boolean;
  limit: number;
  offset: number;
}

export interface OrderReadModel {
  get(orderId: string): Promise<OrderView | null>;
  listByCustomer(customerId: string, limit: number, offset: number): Promise<OrderView[]>;
  /** KIT-1: заказы, которые ресторану нужно принять, готовить или отдать. */
  kitchenQueue(restaurantId: string): Promise<OrderView[]>;
  /** ADM-3: поиск заказов оператором. */
  list(filter: OrderListFilter): Promise<OrderView[]>;
  history(orderId: string): Promise<OrderHistoryView | null>;
}

export const ORDER_READ_MODEL = Symbol("OrderReadModel");
