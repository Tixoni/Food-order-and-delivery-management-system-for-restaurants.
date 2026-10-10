/**
 * Что шлюз получает от сервиса заказов — его внешний контракт, а не
 * внутренние классы. Повторяет ответ `order` (`OrderView`), но объявлен
 * здесь: шлюз не должен зависеть от устройства чужого сервиса.
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
  customerCanCancel?: boolean;
}

export interface OrderTransitionView {
  from: string | null;
  to: string;
  actorType: string;
  reason: string | null;
  at: string;
}

export interface PlaceOrderRequest {
  restaurantId: string;
  idempotencyKey: string;
  address: { text: string; latitude: number; longitude: number };
  contactPhone?: string | null;
  comment?: string | null;
  items: Array<{
    itemId: string;
    quantity: number;
    selections?: Array<{ groupId: string; optionIds: string[] }>;
  }>;
}
