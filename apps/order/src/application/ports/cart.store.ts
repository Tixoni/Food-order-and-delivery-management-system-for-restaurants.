/** Позиция корзины: что выбрал клиент, без цен — цены считает каталог. */
export interface CartLine {
  lineId: string;
  itemId: string;
  quantity: number;
  selections: Array<{ groupId: string; optionIds: string[] }>;
}

export interface Cart {
  customerId: string;
  /** Корзина собирается только из одного ресторана (CART-4). */
  restaurantId: string | null;
  lines: CartLine[];
  updatedAt: string;
}

/**
 * Хранилище корзины.
 *
 * Корзина эфемерна и живёт в кэше сутки: в основной базе она дала бы
 * нагрузку записи на каждое нажатие «+» и задачу уборки брошенных корзин.
 */
export interface CartStore {
  get(customerId: string): Promise<Cart | null>;
  save(cart: Cart): Promise<void>;
  clear(customerId: string): Promise<void>;
}

export const CART_STORE = Symbol("CartStore");
