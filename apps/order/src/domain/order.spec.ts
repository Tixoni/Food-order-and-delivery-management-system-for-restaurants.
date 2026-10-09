import {
  ORDER_STATUSES as CONTRACT_STATUSES,
  CANCEL_REASONS as CONTRACT_REASONS,
} from "@food-delivery/contracts";
import { geoPoint } from "./geo-point";
import { Order, SYSTEM, type Actor } from "./order";
import { InvalidTransitionError, OrderRuleError } from "./order-errors";
import { OrderLine } from "./order-line";
import {
  CANCEL_REASONS,
  ORDER_STATUSES,
  TERMINAL_STATUSES,
  TRANSIENT_STATUSES,
  TRANSITIONS,
  isTransitionAllowed,
  type ActorType,
  type OrderStatus,
} from "./order-status";
import { DEFAULT_TIMEOUTS, timeoutFor } from "./order-timeouts";

const at = new Date("2026-10-12T12:00:00Z");
const customer: Actor = { type: "CUSTOMER", id: "c-1" };
const kitchen: Actor = { type: "RESTAURANT", id: "k-1" };
const operator: Actor = { type: "OPERATOR", id: "op-1" };

const line = (overrides: Partial<Parameters<typeof OrderLine.create>[0]> = {}) =>
  OrderLine.create({
    menuItemId: "item-1",
    name: "Борщ",
    basePrice: 39000,
    quantity: 2,
    options: [{ optionId: "o-1", name: "Сметана", priceDelta: 5000 }],
    ...overrides,
  });

const place = (overrides: Partial<Parameters<typeof Order.place>[0]> = {}) =>
  Order.place(
    {
      id: "order-1",
      orderNumber: 1001,
      customerId: "c-1",
      restaurantId: "r-1",
      idempotencyKey: "key-1",
      addressText: "Москва, Тверская, 1",
      location: geoPoint(55.76, 37.61),
      pickup: geoPoint(55.75, 37.62),
      contactPhone: "+79990000000",
      lines: [line()],
      deliveryFee: 15000,
      serviceFee: 2900,
      comment: null,
      ...overrides,
    },
    at,
  );

/** Заказ, доведённый до нужного статуса по таблице переходов. */
function orderIn(status: OrderStatus): Order {
  const order = place();
  const path: Record<OrderStatus, (o: Order) => void> = {
    CREATED: () => undefined,
    PENDING_PAYMENT: (o) => o.startPayment(at),
    PAID: () => {
      throw new Error("переходный статус");
    },
    AWAITING_RESTAURANT: (o) => (o.startPayment(at), o.markPaid(at)),
    COOKING: (o) => (o.startPayment(at), o.markPaid(at), o.confirm(20, kitchen, at)),
    READY: () => {
      throw new Error("переходный статус");
    },
    ASSIGNING_COURIER: (o) => (
      o.startPayment(at),
      o.markPaid(at),
      o.confirm(20, kitchen, at),
      o.markReady(kitchen, at)
    ),
    IN_TRANSIT: (o) => (
      o.startPayment(at),
      o.markPaid(at),
      o.confirm(20, kitchen, at),
      o.markReady(kitchen, at),
      o.pickUp("courier-1", at)
    ),
    DELIVERED: (o) => (
      o.startPayment(at),
      o.markPaid(at),
      o.confirm(20, kitchen, at),
      o.markReady(kitchen, at),
      o.pickUp("courier-1", at),
      o.deliver("courier-1", at)
    ),
    CANCELLED: (o) => o.cancel(customer, "CUSTOMER", null, at),
  };
  path[status](order);
  order.pullChanges();
  return order;
}

describe("позиция заказа", () => {
  it("цена — снимок: база плюс надбавки, умноженные на количество", () => {
    const l = line();
    expect(l.unitPrice).toBe(44000);
    expect(l.lineTotal).toBe(88000);
  });

  it("отклоняет дробные деньги, нулевое и чрезмерное количество, пустое название", () => {
    expect(() => line({ basePrice: 390.5 })).toThrow(OrderRuleError);
    expect(() => line({ quantity: 0 })).toThrow(OrderRuleError);
    expect(() => line({ quantity: 100 })).toThrow(OrderRuleError);
    expect(() => line({ name: "  " })).toThrow(OrderRuleError);
    expect(() =>
      line({ basePrice: 100, options: [{ optionId: "x", name: "скидка", priceDelta: -200 }] }),
    ).toThrow(/отрицательна/);
  });
});

describe("оформление заказа", () => {
  it("считает итог на сервере: позиции + доставка + сервисный сбор", () => {
    const order = place();
    expect(order.amounts).toEqual({
      items: 88000,
      delivery: 15000,
      service: 2900,
      discount: 0,
      total: 105900,
    });
    expect(order.status).toBe("CREATED");
    expect(order.pullChanges()).toEqual([
      expect.objectContaining({
        from: null,
        to: "CREATED",
        actor: { type: "CUSTOMER", id: "c-1" },
      }),
    ]);
  });

  it("не принимает заказ без позиций, адреса и ключа идемпотентности", () => {
    expect(() => place({ lines: [] })).toThrow(/нет позиций/);
    expect(() => place({ addressText: " " })).toThrow(/адрес/);
    expect(() => place({ idempotencyKey: "" })).toThrow(/идемпотентности/);
    expect(() => place({ idempotencyKey: "k".repeat(101) })).toThrow(/идемпотентности/);
    expect(() => place({ comment: "x".repeat(1001) })).toThrow(/комментарий/);
  });

  it("проверяет координаты адреса", () => {
    expect(() => geoPoint(91, 0)).toThrow(/широта/);
    expect(() => geoPoint(0, 181)).toThrow(/долгота/);
  });
});

describe("автомат статусов (ORD-3)", () => {
  it("статусы и причины отмены совпадают с контрактом событий", () => {
    expect([...ORDER_STATUSES]).toEqual([...CONTRACT_STATUSES]);
    expect([...CANCEL_REASONS]).toEqual([...CONTRACT_REASONS]);
  });

  const actors: ActorType[] = ["CUSTOMER", "RESTAURANT", "COURIER", "OPERATOR", "SYSTEM"];

  it("из терминальных статусов переходов нет", () => {
    for (const from of TERMINAL_STATUSES) {
      for (const to of ORDER_STATUSES) {
        for (const actor of actors) expect(isTransitionAllowed(from, to, actor)).toBe(false);
      }
    }
  });

  it("каждый допустимый переход есть в таблице, остальные — запрещены", () => {
    let allowed = 0;
    for (const from of ORDER_STATUSES) {
      for (const to of ORDER_STATUSES) {
        for (const actor of actors) {
          const expected = TRANSITIONS.some(
            (rule) => rule.from === from && rule.to === to && rule.actors.includes(actor),
          );
          expect(isTransitionAllowed(from, to, actor)).toBe(expected);
          if (expected) allowed += 1;
        }
      }
    }
    expect(allowed).toBe(TRANSITIONS.reduce((sum, rule) => sum + rule.actors.length, 0));
  });

  it("полный путь заказа проходит все статусы по порядку", () => {
    const order = place();
    order.pullChanges();
    order.startPayment(at);
    order.markPaid(at);
    order.confirm(25, kitchen, at);
    order.markReady(kitchen, at);
    order.pickUp("courier-1", at);
    order.deliver("courier-1", at);
    expect(order.pullChanges().map((change) => change.to)).toEqual([
      "PENDING_PAYMENT",
      "PAID",
      "AWAITING_RESTAURANT",
      "COOKING",
      "READY",
      "ASSIGNING_COURIER",
      "IN_TRANSIT",
      "DELIVERED",
    ]);
    expect(order.isTerminal).toBe(true);
    expect(order.expectedCookingMin).toBe(25);
  });

  it("переходные статусы не остаются текущими ни после одной команды", () => {
    for (const status of ORDER_STATUSES.filter((s) => !TRANSIENT_STATUSES.has(s))) {
      expect(TRANSIENT_STATUSES.has(orderIn(status).status)).toBe(false);
    }
  });

  it("повтор успешной команды ничего не меняет и не считается ошибкой", () => {
    const order = orderIn("COOKING");
    expect(order.confirm(25, kitchen, at)).toBe(false);
    expect(order.pullChanges()).toEqual([]);
    const cancelled = orderIn("CANCELLED");
    expect(cancelled.cancel(customer, "CUSTOMER", null, at)).toBe(false);
  });

  it("недопустимый переход отклоняется ошибкой с исходным и целевым статусом", () => {
    const order = orderIn("CREATED");
    expect(() => order.confirm(20, kitchen, at)).toThrow(InvalidTransitionError);
    expect(() => orderIn("DELIVERED").cancel(operator, "OPERATOR", "поздно", at)).toThrow(
      InvalidTransitionError,
    );
  });

  it("клиент отменяет до начала готовки, но не после (ORD-5)", () => {
    for (const status of ["CREATED", "PENDING_PAYMENT", "AWAITING_RESTAURANT"] as const) {
      expect(orderIn(status).cancel(customer, "CUSTOMER", null, at)).toBe(true);
    }
    for (const status of ["COOKING", "ASSIGNING_COURIER", "IN_TRANSIT"] as const) {
      expect(() => orderIn(status).cancel(customer, "CUSTOMER", null, at)).toThrow(
        InvalidTransitionError,
      );
    }
  });

  it("после начала готовки отменяет оператор (ORD-6), система — при сбое, но не после вручения курьеру", () => {
    expect(orderIn("COOKING").cancel(operator, "OPERATOR", "клиент передумал", at)).toBe(true);
    expect(orderIn("ASSIGNING_COURIER").cancel(SYSTEM, "TECHNICAL", null, at)).toBe(true);
    expect(orderIn("IN_TRANSIT").cancel(operator, "OPERATOR", "курьер пропал", at)).toBe(true);
    expect(() => orderIn("IN_TRANSIT").cancel(SYSTEM, "TECHNICAL", null, at)).toThrow(
      InvalidTransitionError,
    );
  });

  it("ресторан отклоняет только ожидающий его заказ (KIT-3)", () => {
    expect(orderIn("AWAITING_RESTAURANT").cancel(kitchen, "RESTAURANT", "нет продуктов", at)).toBe(
      true,
    );
    expect(() => orderIn("COOKING").cancel(kitchen, "RESTAURANT", "передумали", at)).toThrow(
      InvalidTransitionError,
    );
  });

  it("причину отмены нельзя выдать за чужую", () => {
    expect(() => orderIn("CREATED").cancel(customer, "RESTAURANT", null, at)).toThrow(
      OrderRuleError,
    );
    expect(() => orderIn("CREATED").cancel(SYSTEM, "CUSTOMER", null, at)).toThrow(OrderRuleError);
  });

  it("отмена фиксирует причину, время и снимает отметку для оператора", () => {
    const order = orderIn("AWAITING_RESTAURANT");
    order.flagAttention("проверить", at);
    order.cancel(SYSTEM, "TIMEOUT", "ресторан не ответил", at);
    const state = order.snapshot();
    expect(state).toMatchObject({
      cancelReason: "TIMEOUT",
      cancelComment: "ресторан не ответил",
      cancelledAt: at,
    });
    expect(state.attentionReason).toBeNull();
  });

  it("время готовки — целое число минут от 1 до 180 (KIT-2)", () => {
    expect(() => orderIn("AWAITING_RESTAURANT").confirm(0, kitchen, at)).toThrow(OrderRuleError);
    expect(() => orderIn("AWAITING_RESTAURANT").confirm(181, kitchen, at)).toThrow(OrderRuleError);
    expect(() => orderIn("AWAITING_RESTAURANT").confirm(12.5, kitchen, at)).toThrow(OrderRuleError);
  });

  it("курьер забрал заказ раньше отметки «готово» — готовность отмечается автоматически", () => {
    const order = orderIn("COOKING");
    order.pickUp("courier-1", at);
    expect(order.pullChanges().map((c) => [c.to, c.actor.type])).toEqual([
      ["READY", "SYSTEM"],
      ["ASSIGNING_COURIER", "SYSTEM"],
      ["IN_TRANSIT", "COURIER"],
    ]);
  });

  it("отметка для оператора не ставится на завершённый заказ", () => {
    const order = orderIn("DELIVERED");
    order.flagAttention("что-то", at);
    expect(order.attentionReason).toBeNull();
  });
});

describe("сроки статусов (REL-6)", () => {
  it("у каждого нетерминального статуса, в котором заказ может задержаться, есть срок", () => {
    for (const status of ORDER_STATUSES) {
      const timeout = timeoutFor(status, at, { expectedCookingMin: 20 });
      const resting = !TERMINAL_STATUSES.has(status) && !TRANSIENT_STATUSES.has(status);
      expect(timeout !== null).toBe(resting);
    }
  });

  it("ресторан не ответил за 3 минуты — автоотмена (KIT-5)", () => {
    const timeout = timeoutFor("AWAITING_RESTAURANT", at, { expectedCookingMin: null })!;
    expect(timeout).toMatchObject({ action: "cancel", type: "TIMEOUT:AWAITING_RESTAURANT" });
    expect(timeout.fireAt.getTime() - at.getTime()).toBe(3 * 60_000);
  });

  it("готовка и доставка — по заявленному времени × 2, с оповещением оператора", () => {
    const cooking = timeoutFor("COOKING", at, { expectedCookingMin: 25 })!;
    expect(cooking.action).toBe("alert");
    expect(cooking.fireAt.getTime() - at.getTime()).toBe(50 * 60_000);

    const withEta = timeoutFor("IN_TRANSIT", at, { expectedCookingMin: null, etaMinutes: 15 })!;
    expect(withEta.fireAt.getTime() - at.getTime()).toBe(30 * 60_000);
    const withoutEta = timeoutFor("IN_TRANSIT", at, { expectedCookingMin: null })!;
    expect(withoutEta.fireAt.getTime() - at.getTime()).toBe(
      DEFAULT_TIMEOUTS.inTransitDefaultMinutes * 60_000,
    );
  });
});
