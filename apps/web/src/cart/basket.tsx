import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";

/**
 * Выбор клиента до оформления — блюда, модификаторы, количество.
 *
 * Здесь хранится только выбор, а цены — лишь для показа: итог заказа
 * считает сервер по актуальному меню в момент оформления (ORD-2),
 * и сумма, пришедшая из браузера, им не принимается.
 *
 * Корзина собирается из одного ресторана (CART-4): блюда разных
 * ресторанов не могут приехать одним курьером.
 *
 * Выбор хранится в браузере и уходит на сервер целиком при оформлении:
 * сервис заказов принимает позиции прямо в запросе и сам сверяет их
 * с каталогом. Серверная корзина сервиса заказов (CART-1..4) остаётся
 * для других клиентов API — например, мобильного приложения, которому
 * нужна общая корзина на нескольких устройствах.
 */

export interface BasketSelection {
  groupId: string;
  optionIds: string[];
}

export interface BasketLine {
  /** Одно и то же блюдо с разными модификаторами — разные строки. */
  key: string;
  itemId: string;
  name: string;
  quantity: number;
  selections: BasketSelection[];
  /** Названия выбранных модификаторов — для показа в корзине. */
  optionNames: string[];
  /** Цена за штуку с модификаторами на момент выбора, копейки. */
  unitPrice: number;
}

export interface Basket {
  restaurantId: string | null;
  restaurantName: string | null;
  lines: BasketLine[];
}

interface BasketState extends Basket {
  itemsAmount: number;
  count: number;
  /** Добавить блюдо. Ложь — корзина собрана в другом ресторане, нужно согласие клиента. */
  add: (
    restaurant: { id: string; name: string },
    line: Omit<BasketLine, "key">,
    replace?: boolean,
  ) => boolean;
  setQuantity: (key: string, quantity: number) => void;
  clear: () => void;
}

const STORAGE_KEY = "fd:basket";
const EMPTY: Basket = { restaurantId: null, restaurantName: null, lines: [] };
const MAX_QUANTITY = 99;

const BasketContext = createContext<BasketState | null>(null);

/** Ключ строки: блюдо плюс отсортированный выбор модификаторов. */
export function lineKey(itemId: string, selections: BasketSelection[]): string {
  const normalized = [...selections]
    .map((selection) => `${selection.groupId}:${[...selection.optionIds].sort().join(",")}`)
    .sort()
    .join("|");
  return `${itemId}#${normalized}`;
}

/**
 * Добавление строки. Корзина другого ресторана начинается заново —
 * согласие клиента уже получено вызывающим.
 */
function addLine(
  current: Basket,
  restaurant: { id: string; name: string },
  line: Omit<BasketLine, "key">,
): Basket {
  const base = current.restaurantId === restaurant.id ? current : EMPTY;
  const key = lineKey(line.itemId, line.selections);
  const existing = base.lines.find((candidate) => candidate.key === key);
  const lines = existing
    ? base.lines.map((candidate) =>
        candidate.key === key
          ? { ...candidate, quantity: Math.min(MAX_QUANTITY, candidate.quantity + line.quantity) }
          : candidate,
      )
    : [...base.lines, { ...line, key }];
  return { restaurantId: restaurant.id, restaurantName: restaurant.name, lines };
}

function load(): Basket {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    return saved ? { ...EMPTY, ...(JSON.parse(saved) as Basket) } : EMPTY;
  } catch {
    // Запрет на хранение в браузере не должен ломать витрину
    return EMPTY;
  }
}

export function BasketProvider({ children }: { children: ReactNode }) {
  const [basket, setBasket] = useState<Basket>(load);

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(basket));
    } catch {
      // см. load
    }
  }, [basket]);

  const add = useCallback<BasketState["add"]>(
    (restaurant, line, replace = false) => {
      // Проверка по текущей корзине, а не внутри функции обновления:
      // React вправе выполнить её позже, и ответ «нужно согласие» опоздал бы.
      const otherRestaurant =
        basket.restaurantId !== null &&
        basket.restaurantId !== restaurant.id &&
        basket.lines.length > 0;
      if (otherRestaurant && !replace) return false;

      setBasket((current) => addLine(current, restaurant, line));
      return true;
    },
    [basket.restaurantId, basket.lines.length],
  );

  const setQuantity = useCallback((key: string, quantity: number) => {
    setBasket((current) => {
      const lines =
        quantity <= 0
          ? current.lines.filter((line) => line.key !== key)
          : current.lines.map((line) =>
              line.key === key ? { ...line, quantity: Math.min(MAX_QUANTITY, quantity) } : line,
            );
      return lines.length === 0 ? EMPTY : { ...current, lines };
    });
  }, []);

  const clear = useCallback(() => setBasket(EMPTY), []);

  const value = useMemo<BasketState>(
    () => ({
      ...basket,
      itemsAmount: basket.lines.reduce((sum, line) => sum + line.unitPrice * line.quantity, 0),
      count: basket.lines.reduce((sum, line) => sum + line.quantity, 0),
      add,
      setQuantity,
      clear,
    }),
    [basket, add, setQuantity, clear],
  );

  return <BasketContext.Provider value={value}>{children}</BasketContext.Provider>;
}

export function useBasket(): BasketState {
  const basket = useContext(BasketContext);
  if (!basket) throw new Error("useBasket вызван вне BasketProvider");
  return basket;
}
