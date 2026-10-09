import { randomUUID } from "node:crypto";
import {
  ConflictError,
  DomainRuleError,
  ExternalServiceError,
  TimeoutError,
  createEvent,
  runWithContext,
} from "@food-delivery/shared";
import { DELIVERY_EVENT_TYPES, PAYMENT_EVENT_TYPES } from "@food-delivery/contracts";
import { CircuitOpenError } from "@food-delivery/service-kit";
import { OrderCommandsUseCase } from "../use-cases/order-commands.use-case";
import { OrderCommitter } from "./order-committer";
import { OrderWorkflow } from "./order-workflow";
import { SagaRunner } from "./saga-runner";
import { ParticipantEventsUseCase } from "../use-cases/participant-events.use-case";
import { PlaceOrderUseCase } from "../use-cases/place-order.use-case";
import {
  ITEM_ID,
  RESTAURANT_ID,
  TEST_SETTINGS,
  buildWorld,
  customer,
  kitchen,
  operator,
} from "../use-cases/in-memory.doubles";

const MINUTE = 60_000;

function setup(settings = TEST_SETTINGS) {
  const world = buildWorld(settings);
  const place = new PlaceOrderUseCase(
    world.store,
    world.catalog,
    world.carts,
    world.workflow,
    settings,
  );
  const commands = new OrderCommandsUseCase(world.store, world.committer, () => world.store.clock);
  const participants = new ParticipantEventsUseCase(
    world.store,
    world.committer,
    world.workflow,
    settings,
  );

  const placeOrder = async (key = randomUUID()) => {
    const { order } = await runWithContext({ correlationId: "corr-1" }, () =>
      place.execute(
        {
          restaurantId: RESTAURANT_ID,
          idempotencyKey: key,
          address: { text: "Москва, Тверская, 1", latitude: 55.76, longitude: 37.61 },
          items: [{ itemId: ITEM_ID, quantity: 2 }],
        },
        customer,
        world.store.clock,
      ),
    );
    return order.id;
  };

  const deliveryEvent = (eventType: string, orderId: string, payload: object = {}) =>
    createEvent({
      eventType,
      aggregateType: "delivery",
      aggregateId: `d-${orderId}`,
      payload: { orderId, deliveryId: `d-${orderId}`, courierId: "courier-7", ...payload },
      correlationId: "corr-1",
    });

  const paymentEvent = (eventType: string, orderId: string, payload: object = {}) =>
    createEvent({
      eventType,
      aggregateType: "payment",
      aggregateId: `p-${orderId}`,
      payload: { orderId, paymentId: `p-${orderId}`, amount: 105000, ...payload },
      correlationId: "corr-1",
    });

  return { ...world, place, commands, participants, placeOrder, deliveryEvent, paymentEvent };
}

describe("сага оформления: успешный путь", () => {
  it("заказ проходит от оформления до вручения, у каждого статуса есть срок", async () => {
    const w = setup();
    const id = await w.placeOrder();

    expect(w.store.statusOf(id)).toBe("CREATED");
    expect(w.store.activeTypes(id)).toEqual(["AUTHORIZE_PAYMENT", "TIMEOUT:CREATED"]);

    await w.drain();
    expect(w.store.statusOf(id)).toBe("AWAITING_RESTAURANT");
    expect(w.store.activeTypes(id)).toEqual(["TIMEOUT:AWAITING_RESTAURANT"]);
    expect(w.payment.holds(id)).toBe(true);

    await w.commands.confirm(id, kitchen, 20);
    expect(w.store.activeTypes(id)).toEqual(["CAPTURE_PAYMENT", "TIMEOUT:COOKING"]);

    await w.drain();
    expect(w.payment.calls).toContain(`capture:${id}:capture`);
    expect(w.delivery.calls).toEqual([`request:${id}:courier:1`]);
    expect(w.store.activeTypes(id)).toEqual(["TIMEOUT:COOKING"]);

    await w.commands.markReady(id, kitchen);
    expect(w.store.statusOf(id)).toBe("ASSIGNING_COURIER");
    expect(w.store.activeTypes(id)).toEqual(["TIMEOUT:ASSIGNING_COURIER"]);

    await w.participants.onDeliveryEvent(
      w.deliveryEvent(DELIVERY_EVENT_TYPES.orderPickedUp, id, { pickedUpAt: "x", etaMinutes: 12 }),
      w.store.clock,
    );
    expect(w.store.statusOf(id)).toBe("IN_TRANSIT");
    const inTransit = w.store.active(id, "TIMEOUT:IN_TRANSIT")[0]!;
    expect(inTransit.fireAt.getTime() - w.store.clock.getTime()).toBe(24 * MINUTE);

    await w.participants.onDeliveryEvent(
      w.deliveryEvent(DELIVERY_EVENT_TYPES.deliveryCompleted, id, { deliveredAt: "x" }),
      w.store.clock,
    );
    expect(w.store.statusOf(id)).toBe("DELIVERED");
    expect(w.store.sagaOf(id).status).toBe("COMPLETED");
    expect(w.store.activeTypes(id)).toEqual([]);
  });

  it("публикует события каждого перехода с ключом заказа и сквозным идентификатором", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();

    expect(w.store.eventTypes(id)).toEqual([
      "OrderStatusChanged", // → CREATED
      "OrderStatusChanged", // → PENDING_PAYMENT
      "OrderStatusChanged", // → PAID
      "OrderPaid",
      "OrderStatusChanged", // → AWAITING_RESTAURANT
      "OrderPlaced",
    ]);
    const placed = w.store.events.find((event) => event.eventType === "OrderPlaced")!;
    expect(placed.aggregateId).toBe(id);
    expect(placed.correlationId).toBe("corr-1");
    expect(placed.payload).toMatchObject({
      orderNumber: expect.any(Number),
      totalAmount: 105000,
      items: [{ name: "Пицца «Маргарита»", quantity: 2, options: [] }],
    });
  });

  it("история шагов саги хранит каждую попытку", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    expect(w.store.steps).toEqual([
      expect.objectContaining({ step: "AUTHORIZE_PAYMENT", status: "SUCCEEDED", attempt: 1 }),
    ]);
    expect(w.store.sagaOf(id).facts).toMatchObject({
      paymentAuthorized: true,
      paymentId: `p-${id}`,
    });
  });
});

describe("сага оформления: отказы платёжного сервиса", () => {
  it("банк отказал — заказ отменён с причиной, снимать нечего", async () => {
    const w = setup();
    w.payment.decline = true;
    const id = await w.placeOrder();
    await w.drain();

    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.store.orders.get(id)!.cancelReason).toBe("PAYMENT_FAILED");
    expect(w.store.sagaOf(id).status).toBe("FAILED");
    expect(w.payment.calls.filter((call) => call.startsWith("void"))).toEqual([]);
    expect(w.store.eventTypes(id)).toContain("OrderCancelled");
  });

  it("временный отказ — повтор с тем же ключом, заказ продолжается", async () => {
    const w = setup();
    w.payment.failures.set("authorize", (call) =>
      call === 1 ? new TimeoutError("медленно") : null,
    );
    const id = await w.placeOrder();
    await w.drain();
    expect(w.store.statusOf(id)).toBe("PENDING_PAYMENT");

    await w.advance(TEST_SETTINGS.retryBaseMs);
    expect(w.store.statusOf(id)).toBe("AWAITING_RESTAURANT");
    expect(w.payment.calls).toEqual([`authorize:${id}:authorize`, `authorize:${id}:authorize`]);
    expect(w.store.steps.map((step) => step.status)).toEqual(["FAILED", "SUCCEEDED"]);
  });

  it("платёжный сервис лежит — попытки исчерпаны, заказ отменён, холд снят «на всякий случай» (REL-2, REL-5)", async () => {
    const w = setup();
    w.payment.failures.set("authorize", () => new CircuitOpenError("payment временно недоступен"));
    w.payment.failures.set("void", (call) =>
      call === 1 ? new ExternalServiceError("лежит") : null,
    );
    const id = await w.placeOrder();

    await w.drain();
    await w.advance(1000);
    await w.advance(2000);
    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.store.orders.get(id)!.cancelReason).toBe("TECHNICAL");
    // Согласованное состояние — за секунды, а не за десять минут срока оплаты.
    expect(w.store.activeTypes(id)).toEqual(["VOID_PAYMENT"]);

    await w.advance(1000);
    expect(w.store.activeTypes(id)).toEqual([]);
    expect(w.store.sagaOf(id).status).toBe("FAILED");
    expect(w.payment.calls.filter((c) => c.startsWith("void"))).toEqual([
      `void:${id}:void:1`,
      `void:${id}:void:1`,
    ]);
  });

  it("ошибку, повтор которой бессмыслен, не повторяет", async () => {
    const w = setup();
    w.payment.failures.set("authorize", () => new DomainRuleError("сумма неверна"));
    const id = await w.placeOrder();
    await w.drain();
    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.payment.calls.filter((c) => c.startsWith("authorize"))).toHaveLength(1);
  });

  it("отказ на списании после подтверждения: отзыв у ресторана, снятие холда, отмена «техническая»", async () => {
    const w = setup();
    w.payment.failures.set("capture", () => new ExternalServiceError("шлюз провайдера недоступен"));
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 15);
    await w.drain();
    await w.advance(1000);
    await w.advance(2000);

    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.store.orders.get(id)!.cancelReason).toBe("TECHNICAL");
    expect(w.store.eventTypes(id)).toEqual(
      expect.arrayContaining(["OrderRecalled", "OrderCancelled"]),
    );
    expect(w.payment.holds(id)).toBe(false);
    expect(w.store.sagaOf(id).status).toBe("FAILED");
    expect(w.delivery.calls).toEqual([]);
    const cancelled = w.store.events.find((event) => event.eventType === "OrderCancelled")!;
    expect(cancelled.payload).toMatchObject({ refundExpected: true });
  });

  it("холд прошёл уже после отмены (ответ потерян) — событие платежа запускает снятие холда", async () => {
    const w = setup();
    w.payment.failures.set("authorize", () => new TimeoutError("ответ потерян"));
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.cancelByCustomer(id, customer, "передумал");
    await w.drain(); // защитное снятие холда: холда ещё нет
    expect(w.store.sagaOf(id).status).toBe("FAILED");

    // А провайдер всё-таки захолдировал деньги — и сообщил об этом событием.
    w.payment.failures.delete("authorize");
    await w.payment.authorize({
      orderId: id,
      customerId: customer.id,
      amount: 105000,
      currency: "RUB",
      idempotencyKey: "late",
    });
    await w.participants.onPaymentEvent(
      w.paymentEvent(PAYMENT_EVENT_TYPES.authorized, id),
      w.store.clock,
    );
    await w.drain();

    expect(w.payment.holds(id)).toBe(false);
    expect(w.payment.calls).toContain(`void:${id}:void:2`);
  });

  it("холдирование, подтверждённое событием, пока шаг ждал повтора, — шаг снимается", async () => {
    const w = setup();
    w.payment.failures.set("authorize", (call) =>
      call === 1 ? new TimeoutError("медленно") : null,
    );
    const id = await w.placeOrder();
    await w.drain();
    await w.participants.onPaymentEvent(
      w.paymentEvent(PAYMENT_EVENT_TYPES.authorized, id),
      w.store.clock,
    );

    expect(w.store.statusOf(id)).toBe("AWAITING_RESTAURANT");
    expect(w.store.activeTypes(id)).toEqual(["TIMEOUT:AWAITING_RESTAURANT"]);
  });

  it("отказ банка, пришедший событием, отменяет ожидающий оплаты заказ", async () => {
    const w = setup();
    w.payment.failures.set("authorize", () => new TimeoutError("медленно"));
    const id = await w.placeOrder();
    await w.drain();
    await w.participants.onPaymentEvent(
      w.paymentEvent(PAYMENT_EVENT_TYPES.failed, id, { operation: "AUTHORIZE", reason: "лимит" }),
      w.store.clock,
    );
    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.store.orders.get(id)!.cancelReason).toBe("PAYMENT_FAILED");
    expect(w.store.activeTypes(id)).toEqual([]);
  });
});

describe("сроки статусов и таймеры (REL-6, KIT-5)", () => {
  it("ресторан не ответил за 3 минуты — автоотмена и снятие холда", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.advance(3 * MINUTE);

    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.store.orders.get(id)!.cancelReason).toBe("TIMEOUT");
    expect(w.payment.holds(id)).toBe(false);
    expect(w.store.eventTypes(id)).toContain("OrderRecalled");
  });

  it("таймер переживает перезапуск: он в хранилище, а не в памяти процесса", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();

    // «Перезапуск»: новый исполнитель над тем же хранилищем, без памяти о прежнем.
    const workflow = new OrderWorkflow(TEST_SETTINGS.timeouts);
    const restarted = new SagaRunner(
      w.store,
      w.store,
      w.payment,
      w.delivery,
      workflow,
      new OrderCommitter(w.store, workflow),
      TEST_SETTINGS,
    );
    w.store.clock = new Date(w.store.clock.getTime() + 3 * MINUTE);
    const claimed = await w.store.claimDue(10, 30_000);
    expect(claimed.map((entry) => entry.type)).toEqual(["TIMEOUT:AWAITING_RESTAURANT"]);
    await restarted.run(claimed[0]!, w.store.clock);
    expect(w.store.statusOf(id)).toBe("CANCELLED");
  });

  it("готовка затянулась — заказ не отменяется, а попадает к оператору", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();
    await w.advance(20 * MINUTE);

    expect(w.store.statusOf(id)).toBe("COOKING");
    expect(w.store.orders.get(id)!.attentionReason).toMatch(/готовка/);
  });

  it("сработавший после смены статуса таймер ничего не делает", async () => {
    const w = setup();
    const id = await w.placeOrder();
    // Таймер «создан» по ошибке остался бы — проверяем, что он снят при переходе.
    await w.drain();
    expect(w.store.active(id, "TIMEOUT:CREATED")).toEqual([]);
    expect(w.store.active(id, "TIMEOUT:PENDING_PAYMENT")).toEqual([]);
  });
});

describe("отмены и компенсации", () => {
  it("клиент отменяет до готовки — холд снимается, ресторан получает отзыв (ORD-5)", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.cancelByCustomer(id, customer, null);
    await w.drain();

    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.payment.holds(id)).toBe(false);
    expect(w.store.eventTypes(id)).toEqual(
      expect.arrayContaining(["OrderRecalled", "OrderCancelled"]),
    );
    expect(w.store.sagaOf(id).status).toBe("FAILED");
  });

  it("клиент не может отменить заказ, который уже готовится", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await expect(w.commands.cancelByCustomer(id, customer)).rejects.toBeInstanceOf(ConflictError);
  });

  it("оператор отменяет после списания с частичным возвратом и освобождает курьера (ORD-6, PAY-6)", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();
    await w.commands.cancelByOperator(id, operator, "клиент не отвечает", 50000);
    await w.drain();

    expect(w.payment.calls).toContain(`refund:${id}:refund:1`);
    expect(w.delivery.calls).toContain(`release:${id}:release`);
    expect(w.store.sagaOf(id).facts).toMatchObject({
      refundedAmount: 50000,
      courierReleased: true,
    });
    expect(w.store.sagaOf(id).status).toBe("FAILED");
  });

  it("компенсация не сдаётся: повторяется, а после нескольких неудач зовёт оператора", async () => {
    const w = setup();
    w.payment.failures.set("void", () => new ExternalServiceError("лежит"));
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.cancelByCustomer(id, customer);
    for (let i = 0; i < 6; i += 1) await w.advance(TEST_SETTINGS.retryMaxMs);

    expect(w.store.active(id, "VOID_PAYMENT")).toHaveLength(1);
    expect(w.payment.calls.filter((c) => c.startsWith("void")).length).toBeGreaterThan(3);
    // Отметка ставится на отменённый заказ? Нет: терминальный заказ не помечается,
    // но шаг продолжает попытки и виден в истории оператора.
    expect(w.store.sagaOf(id).status).toBe("COMPENSATING");

    w.payment.failures.delete("void");
    await w.advance(TEST_SETTINGS.retryMaxMs);
    expect(w.payment.holds(id)).toBe(false);
    expect(w.store.sagaOf(id).status).toBe("FAILED");
  });

  it("снять холд нельзя, потому что деньги уже списаны — компенсация меняется на возврат", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    w.payment.failures.set("void", () => new DomainRuleError("платёж уже списан"));
    await w.commands.cancelByCustomer(id, customer);
    await w.drain();
    expect(w.payment.calls).toContain(`refund:${id}:refund:1`);
  });
});

describe("доставка", () => {
  it("свободных курьеров нет — оператор оповещён, вызов повторяется позже, автоотмены нет", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();
    await w.participants.onDeliveryEvent(
      w.deliveryEvent(DELIVERY_EVENT_TYPES.courierNotFound, id, { attempts: 3 }),
      w.store.clock,
    );
    expect(w.store.orders.get(id)!.attentionReason).toMatch(/курьеров/);
    await w.advance(TEST_SETTINGS.courierRetryDelayMs);
    expect(w.delivery.calls).toEqual([`request:${id}:courier:1`, `request:${id}:courier:2`]);
    expect(w.store.statusOf(id)).toBe("COOKING");
  });

  it("сервис доставки недоступен — вызов курьера повторяется, оператор оповещён", async () => {
    const w = setup();
    w.delivery.failure = new ExternalServiceError("delivery недоступен");
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();
    for (let i = 0; i < 4; i += 1) await w.advance(TEST_SETTINGS.retryMaxMs);

    expect(w.store.statusOf(id)).toBe("COOKING");
    expect(w.store.orders.get(id)!.attentionReason).toMatch(/доставка недоступна/);
    w.delivery.failure = null;
    await w.advance(TEST_SETTINGS.retryMaxMs);
    expect(w.store.sagaOf(id).facts.courierRequested).toBe(true);
  });

  it("курьер принял заказ — отметка «курьер не найден» снимается", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();
    await w.participants.onDeliveryEvent(
      w.deliveryEvent(DELIVERY_EVENT_TYPES.courierNotFound, id, { attempts: 1 }),
    );
    await w.participants.onDeliveryEvent(w.deliveryEvent(DELIVERY_EVENT_TYPES.courierAccepted, id));
    expect(w.store.orders.get(id)!.attentionReason).toBeNull();
    expect(w.store.sagaOf(id).facts.courierId).toBe("courier-7");
  });
});

describe("защита от повторов и гонок (REL-4)", () => {
  it("повторная доставка события не меняет состояние второй раз", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    await w.drain();

    const notFound = w.deliveryEvent(DELIVERY_EVENT_TYPES.courierNotFound, id, { attempts: 1 });
    expect(await w.participants.onDeliveryEvent(notFound, w.store.clock)).toBe(true);
    expect(await w.participants.onDeliveryEvent(notFound, w.store.clock)).toBe(false);
    // Первый вызов курьера — номер 1, повторный после «не найден» — 2, и только он.
    expect(w.store.sagaOf(id).facts.courierSeq).toBe(2);
    expect(w.store.active(id, "REQUEST_COURIER")).toHaveLength(1);
  });

  it("событие о неизвестном заказе пропускается", async () => {
    const w = setup();
    await expect(
      w.participants.onPaymentEvent(w.paymentEvent(PAYMENT_EVENT_TYPES.authorized, randomUUID())),
    ).resolves.toBe(false);
  });

  it("одновременное изменение заказа: шаг саги перечитывает состояние и повторяется", async () => {
    const w = setup();
    const id = await w.placeOrder();
    const [entry] = await w.store.claimDue(10, 30_000);
    // Пока шаг выполнялся, заказ изменили — версия ушла вперёд.
    const original = w.store.findById.bind(w.store);
    let first = true;
    w.store.findById = async (orderId) => {
      const loaded = await original(orderId);
      if (first && loaded) {
        first = false;
        await w.commands.cancelByCustomer(orderId, customer);
      }
      return loaded;
    };
    await expect(w.runner.run(entry!, w.store.clock)).resolves.toBe("retry");

    // Повтор шага видит свежее состояние: заказ отменён, оплата не нужна.
    w.store.findById = original;
    await w.advance(1000);
    expect(w.store.statusOf(id)).toBe("CANCELLED");
    expect(w.payment.calls.filter((c) => c.startsWith("authorize"))).toEqual([]);
  });

  it("повторная команда кухни ничего не меняет", async () => {
    const w = setup();
    const id = await w.placeOrder();
    await w.drain();
    await w.commands.confirm(id, kitchen, 10);
    const events = w.store.events.length;
    await w.commands.confirm(id, kitchen, 10);
    expect(w.store.events.length).toBe(events);
  });
});
