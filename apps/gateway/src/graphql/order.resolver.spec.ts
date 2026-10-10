import { ExternalServiceError } from "@food-delivery/shared";
import type { CatalogCache } from "../catalog/catalog.cache";
import type { CatalogClient } from "../catalog/catalog.client";
import { loadConfig } from "../config/configuration";
import type { OrderClient } from "../order/order.client";
import type { OrderView } from "../order/order.views";
import type { Order } from "./order.models";
import { OrderResolver } from "./order.resolver";

const view = (overrides: Partial<OrderView> = {}): OrderView => ({
  id: "o-1",
  orderNumber: 1001,
  customerId: "c-1",
  restaurantId: "r-1",
  status: "AWAITING_RESTAURANT",
  addressText: "Тверская, 7",
  comment: null,
  amounts: { items: 100_000, delivery: 15_000, service: 0, discount: 0, total: 115_000 },
  lines: [],
  expectedCookingMin: null,
  placedAt: "2026-10-10T10:00:00Z",
  confirmedAt: null,
  readyAt: null,
  pickedUpAt: null,
  deliveredAt: null,
  cancelledAt: null,
  cancelReason: null,
  cancelComment: null,
  ...overrides,
});

describe("OrderResolver", () => {
  const restaurant = jest.fn();
  // Кэш в тесте прозрачный: каждый вызов идёт в каталог.
  const cache = {
    through: (_key: string, load: () => Promise<unknown>) => load(),
    restaurantKey: (id: string, suffix: string) => `${id}:${suffix}`,
  } as unknown as CatalogCache;
  const orders = { mine: jest.fn(), place: jest.fn() } as unknown as jest.Mocked<OrderClient>;
  const resolver = new OrderResolver(orders, { restaurant } as unknown as CatalogClient, cache, {
    ...loadConfig(),
    logLevel: "error",
  });

  beforeEach(() => {
    restaurant.mockReset();
  });

  it("признак отмены берёт из ответа сервиса заказов, по умолчанию — нельзя", async () => {
    orders.mine.mockResolvedValue([view({ customerCanCancel: true }), view({ id: "o-2" })]);

    const result = await resolver.myOrders(20, 0, "token");

    expect(result.map((order) => order.canCancel)).toEqual([true, false]);
  });

  it("в одном запросе запрашивает каждый ресторан из каталога один раз", async () => {
    restaurant.mockResolvedValue({ id: "r-1", name: "Пельменная" });
    const context = {};
    const order = { restaurantId: "r-1" } as Order;

    const names = await Promise.all([
      resolver.restaurant(order, context),
      resolver.restaurant(order, context),
      resolver.restaurant({ restaurantId: "r-1" } as Order, context),
    ]);

    expect(names.map((r) => r?.name)).toEqual(["Пельменная", "Пельменная", "Пельменная"]);
    expect(restaurant).toHaveBeenCalledTimes(1);
  });

  it("каталог недоступен — заказ отдаётся без ресторана, а не ошибкой (REL-2)", async () => {
    restaurant.mockRejectedValue(new ExternalServiceError("catalog временно недоступен"));

    await expect(resolver.restaurant({ restaurantId: "r-1" } as Order, {})).resolves.toBeNull();
  });
});
