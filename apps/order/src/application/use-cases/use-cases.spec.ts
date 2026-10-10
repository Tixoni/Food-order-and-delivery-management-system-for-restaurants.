import { randomUUID } from "node:crypto";
import {
  ConflictError,
  DomainRuleError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  ValidationError,
} from "@food-delivery/shared";
import type { Requester } from "../access";
import { CartUseCases } from "./cart.use-cases";
import {
  ITEM_ID,
  RESTAURANT_ID,
  TEST_SETTINGS,
  buildWorld,
  customer,
  kitchen,
  operator,
} from "./in-memory.doubles";
import { OrderCommandsUseCase } from "./order-commands.use-case";
import { OrderQueriesUseCase } from "./order-queries.use-case";
import { PlaceOrderUseCase, type PlaceOrderInput } from "./place-order.use-case";
import type { OrderReadModel, OrderView } from "../ports/order-read-model";
import { ConcurrentModificationError } from "../ports/order.repository";

const OTHER_RESTAURANT = "11111111-2222-4333-8444-555555555555";

function setup() {
  const world = buildWorld();
  const place = new PlaceOrderUseCase(
    world.store,
    world.catalog,
    world.carts,
    world.workflow,
    TEST_SETTINGS,
  );
  const commands = new OrderCommandsUseCase(world.store, world.committer, () => world.store.clock);
  const carts = new CartUseCases(world.carts, world.catalog, TEST_SETTINGS);
  const input = (overrides: Partial<PlaceOrderInput> = {}): PlaceOrderInput => ({
    restaurantId: RESTAURANT_ID,
    idempotencyKey: randomUUID(),
    address: { text: "Москва, Тверская, 1", latitude: 55.76, longitude: 37.61 },
    items: [{ itemId: ITEM_ID, quantity: 1 }],
    ...overrides,
  });
  return { ...world, place, commands, carts, input };
}

describe("оформление заказа (ORD-1, ORD-2, ORD-4)", () => {
  it("цены и зона — только по ответу каталога; сервисный сбор — по настройке", async () => {
    const w = setup();
    const { order, replayed } = await w.place.execute(w.input(), customer, w.store.clock);
    expect(replayed).toBe(false);
    expect(order.amounts).toMatchObject({ items: 45000, delivery: 15000, total: 60000 });
    expect(w.catalog.calls[0]).toMatchObject({ latitude: 55.76, longitude: 37.61 });
  });

  it("повтор с тем же ключом — тот же заказ, каталог второй раз не спрашивается", async () => {
    const w = setup();
    const input = w.input();
    const first = await w.place.execute(input, customer);
    const second = await w.place.execute(input, customer);
    expect(second).toMatchObject({ replayed: true });
    expect(second.order.id).toBe(first.order.id);
    expect(w.catalog.calls).toHaveLength(1);
  });

  it("тот же ключ для другого ресторана — конфликт, а не чужой заказ", async () => {
    const w = setup();
    const input = w.input();
    await w.place.execute(input, customer);
    await expect(
      w.place.execute({ ...input, restaurantId: OTHER_RESTAURANT }, customer),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("оформляет только клиент; ключ, адрес и координаты обязательны", async () => {
    const w = setup();
    await expect(w.place.execute(w.input(), kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      w.place.execute(w.input({ idempotencyKey: " " }), customer),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      w.place.execute(w.input({ address: undefined as never }), customer),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      w.place.execute(w.input({ address: { text: "x", latitude: 120, longitude: 0 } }), customer),
    ).rejects.toBeInstanceOf(DomainRuleError);
  });

  it("отказ каталога (вне зоны, ниже минимума) доходит до клиента как есть", async () => {
    const w = setup();
    w.catalog.failure = new DomainRuleError("ресторан не доставляет по указанному адресу");
    await expect(w.place.execute(w.input(), customer)).rejects.toThrow(/не доставляет/);
    expect(w.store.orders.size).toBe(0);
  });

  it("расчёт каталога, не сходящийся с позициями, не принимается — чек бы не сошёлся", async () => {
    const w = setup();
    const original = w.catalog.validateCart.bind(w.catalog);
    w.catalog.validateCart = async (...args) => ({ ...(await original(...args)), itemsAmount: 1 });
    await expect(w.place.execute(w.input(), customer)).rejects.toBeInstanceOf(InternalError);
  });

  it("без явных позиций берёт корзину и очищает её после оформления", async () => {
    const w = setup();
    await w.carts.add(customer, { restaurantId: RESTAURANT_ID, itemId: ITEM_ID, quantity: 2 });
    const { order } = await w.place.execute(w.input({ items: undefined }), customer);
    expect(order.amounts.items).toBe(90000);
    expect(await w.carts.view(customer)).toMatchObject({ lines: [] });
  });

  it("пустая корзина или корзина другого ресторана — ошибка ввода", async () => {
    const w = setup();
    await expect(w.place.execute(w.input({ items: undefined }), customer)).rejects.toThrow(
      /корзина пуста/,
    );
    await w.carts.add(customer, { restaurantId: OTHER_RESTAURANT, itemId: ITEM_ID, quantity: 1 });
    await expect(w.place.execute(w.input({ items: undefined }), customer)).rejects.toThrow(
      /другого ресторана/,
    );
  });
});

describe("права на заказ (SEC-2)", () => {
  it("кухня чужого ресторана не видит и не принимает заказ — «не найден»", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    await w.drain();
    const stranger: Requester = { id: "k-2", roles: ["kitchen"], restaurantId: OTHER_RESTAURANT };
    await expect(w.commands.confirm(order.id, stranger, 10)).rejects.toBeInstanceOf(NotFoundError);
    await expect(w.commands.confirm(order.id, customer, 10)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("клиент не отменяет чужой заказ; отмену оператора делает только оператор", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    const other: Requester = { id: randomUUID(), roles: ["client"] };
    await expect(w.commands.cancelByCustomer(order.id, other)).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(w.commands.cancelByOperator(order.id, customer, "хочу")).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("оператор указывает причину и разумную сумму возврата", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    await expect(w.commands.cancelByOperator(order.id, operator, " ")).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      w.commands.cancelByOperator(order.id, operator, "ошибка", 10_000_000),
    ).rejects.toThrow(/больше суммы заказа/);
    await expect(
      w.commands.cancelByOperator(order.id, operator, "ошибка", 1.5),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("кухня отклоняет только с причиной; оператор снимает отметку «нужно внимание»", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    await w.drain();
    await expect(w.commands.reject(order.id, kitchen, "")).rejects.toBeInstanceOf(ValidationError);

    await w.commands.confirm(order.id, kitchen, 10);
    await w.drain();
    await w.advance(20 * 60_000);
    expect(w.store.orders.get(order.id)!.attentionReason).not.toBeNull();
    await w.commands.clearAttention(order.id, operator);
    expect(w.store.orders.get(order.id)!.attentionReason).toBeNull();
    await expect(w.commands.clearAttention(order.id, customer)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("несуществующий заказ — «не найден»", async () => {
    const w = setup();
    await expect(w.commands.markReady(randomUUID(), kitchen)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe("одновременные записи", () => {
  /** Первое сохранение проигрывает: перед ним успевает другая запись. */
  function loseFirstSave(w: ReturnType<typeof setup>, before: () => Promise<unknown>) {
    const save = w.store.save.bind(w.store);
    let lost = false;
    jest.spyOn(w.store, "save").mockImplementation(async (change) => {
      if (!lost) {
        lost = true;
        await before();
        throw new ConcurrentModificationError("заказ изменён одновременно");
      }
      return save(change);
    });
  }

  it("служебная запись саги не превращается для клиента в ошибку отмены", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    await w.drain();
    loseFirstSave(w, async () => undefined);

    const cancelled = await w.commands.cancelByCustomer(order.id, customer);

    expect(cancelled.status).toBe("CANCELLED");
    expect(w.store.save).toHaveBeenCalledTimes(2);
  });

  it("если заказ за это время начали готовить — настоящий конфликт", async () => {
    const w = setup();
    const { order } = await w.place.execute(w.input(), customer);
    await w.drain();
    loseFirstSave(w, () => w.commands.confirm(order.id, kitchen, 15));

    await expect(w.commands.cancelByCustomer(order.id, customer)).rejects.toThrow(
      /действие недоступно/,
    );
  });
});

describe("чтение заказов", () => {
  const view = (overrides: Partial<OrderView> = {}) =>
    ({
      id: "o-1",
      customerId: customer.id,
      restaurantId: RESTAURANT_ID,
      ...overrides,
    }) as OrderView;
  const readModel = (orders: OrderView[]): OrderReadModel => ({
    get: async (id) => orders.find((o) => o.id === id) ?? null,
    listByCustomer: async (customerId) => orders.filter((o) => o.customerId === customerId),
    kitchenQueue: async (restaurantId) => orders.filter((o) => o.restaurantId === restaurantId),
    list: async () => orders,
    history: async (orderId) => ({
      orderId,
      transitions: [],
      saga: { status: "RUNNING", currentStep: "X", facts: {}, steps: [] },
      pending: [{ type: "TIMEOUT:COOKING", fireAt: "x", attempts: 0, lastError: null }],
    }),
  });

  it("клиент видит свой заказ, чужой — «не найден»; кухня — заказы своего ресторана", async () => {
    const queries = new OrderQueriesUseCase(readModel([view()]));
    await expect(queries.get("o-1", customer)).resolves.toMatchObject({ id: "o-1" });
    await expect(queries.get("o-1", { id: "x", roles: ["client"] })).rejects.toBeInstanceOf(
      NotFoundError,
    );
    await expect(queries.get("o-1", kitchen)).resolves.toBeDefined();
    await expect(queries.kitchenQueue(OTHER_RESTAURANT, kitchen)).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  it("клиенту приходит признак «можно отменить» по таблице переходов (ORD-5)", async () => {
    const queries = new OrderQueriesUseCase(
      readModel([
        view(),
        view({ id: "o-2", status: "AWAITING_RESTAURANT" }),
        view({ id: "o-3", status: "COOKING" }),
      ]),
    );
    const flags = (await queries.listMine(customer)).map((o) => o.customerCanCancel);
    expect(flags).toEqual([false, true, false]);
    // Кухне признак не нужен и не отдаётся.
    await expect(queries.get("o-2", kitchen)).resolves.not.toHaveProperty("customerCanCancel");
  });

  it("клиент видит только переходы; шаги саги и таймеры — оператору", async () => {
    const queries = new OrderQueriesUseCase(readModel([view()]));
    await expect(queries.history("o-1", customer)).resolves.toMatchObject({
      saga: null,
      pending: [],
    });
    await expect(queries.history("o-1", operator)).resolves.toMatchObject({
      pending: [{ type: "TIMEOUT:COOKING" }],
    });
  });

  it("поиск оператора проверяет статусы и границы страницы", async () => {
    const queries = new OrderQueriesUseCase(readModel([view()]));
    await expect(queries.list(operator, { statuses: ["COOKING"] })).resolves.toHaveLength(1);
    await expect(queries.list(operator, { statuses: ["LOST"] })).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(queries.list(operator, { limit: 1000 })).rejects.toBeInstanceOf(ValidationError);
    await expect(queries.list(customer, {})).rejects.toBeInstanceOf(ForbiddenError);
    await expect(queries.listMine(kitchen)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(queries.listMine(customer, 5, 0)).resolves.toHaveLength(1);
  });
});

describe("корзина (CART-1..4)", () => {
  it("складывает одинаковые позиции, считает итог по адресу через каталог", async () => {
    const w = setup();
    await w.carts.add(customer, { restaurantId: RESTAURANT_ID, itemId: ITEM_ID, quantity: 1 });
    const cart = await w.carts.add(customer, {
      restaurantId: RESTAURANT_ID,
      itemId: ITEM_ID,
      quantity: 2,
    });
    expect(cart.lines).toEqual([expect.objectContaining({ quantity: 3 })]);

    const priced = await w.carts.view(customer, { latitude: 55.76, longitude: 37.61 });
    expect(priced.pricing).toEqual({
      itemsAmount: 135000,
      deliveryFee: 15000,
      serviceFee: 0,
      total: 150000,
    });
  });

  it("только один ресторан: другой — ошибка, с явным согласием — новая корзина (CART-4)", async () => {
    const w = setup();
    await w.carts.add(customer, { restaurantId: RESTAURANT_ID, itemId: ITEM_ID, quantity: 1 });
    await expect(
      w.carts.add(customer, { restaurantId: OTHER_RESTAURANT, itemId: ITEM_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(DomainRuleError);
    const replaced = await w.carts.add(customer, {
      restaurantId: OTHER_RESTAURANT,
      itemId: ITEM_ID,
      quantity: 1,
      replaceRestaurant: true,
    });
    expect(replaced.restaurantId).toBe(OTHER_RESTAURANT);
  });

  it("причина, по которой корзину нельзя оформить, показывается рядом с ней (CART-3)", async () => {
    const w = setup();
    await w.carts.add(customer, { restaurantId: RESTAURANT_ID, itemId: ITEM_ID, quantity: 1 });
    w.catalog.failure = new DomainRuleError("не достигнута минимальная сумма заказа");
    const view = await w.carts.view(customer, { latitude: 55.76, longitude: 37.61 });
    expect(view).toMatchObject({
      pricing: null,
      problem: "не достигнута минимальная сумма заказа",
    });
  });

  it("меняет количество, удаляет позицию и очищает корзину", async () => {
    const w = setup();
    const cart = await w.carts.add(customer, {
      restaurantId: RESTAURANT_ID,
      itemId: ITEM_ID,
      quantity: 1,
    });
    const lineId = cart.lines[0]!.lineId;
    expect((await w.carts.setQuantity(customer, lineId, 5)).lines[0]!.quantity).toBe(5);
    await expect(w.carts.setQuantity(customer, lineId, 100)).rejects.toBeInstanceOf(
      ValidationError,
    );
    expect(await w.carts.remove(customer, lineId)).toMatchObject({ lines: [], restaurantId: null });
    await expect(w.carts.remove(customer, lineId)).rejects.toBeInstanceOf(NotFoundError);
    expect(await w.carts.clear(customer)).toMatchObject({ lines: [] });
  });

  it("проверяет ввод и роль", async () => {
    const w = setup();
    await expect(
      w.carts.add(customer, { restaurantId: "nope", itemId: ITEM_ID, quantity: 1 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      w.carts.add(customer, { restaurantId: RESTAURANT_ID, itemId: ITEM_ID, quantity: 0 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(w.carts.view(kitchen)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
