import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { ConflictError, createEvent, runWithContext } from "@food-delivery/shared";
import { DELIVERY_EVENT_TYPES } from "@food-delivery/contracts";
import { PlaceOrderUseCase } from "../../application/use-cases/place-order.use-case";
import { OrderCommandsUseCase } from "../../application/use-cases/order-commands.use-case";
import { ParticipantEventsUseCase } from "../../application/use-cases/participant-events.use-case";
import { DuplicateMessageError } from "../../application/ports/order.repository";
import { OrderCommitter } from "../../application/saga/order-committer";
import { OrderWorkflow } from "../../application/saga/order-workflow";
import { SagaRunner } from "../../application/saga/saga-runner";
import {
  FakeCatalog,
  FakeDelivery,
  FakePayment,
  ITEM_ID,
  InMemoryCartStore,
  RESTAURANT_ID,
  TEST_SETTINGS,
  customer,
  kitchen,
} from "../../application/use-cases/in-memory.doubles";
import { TypeOrmOrderReadModel } from "./typeorm-order-read-model";
import { TypeOrmOrderRepository } from "./typeorm-order.repository";

const connectionUrl = process.env.ORDER_INTEGRATION_DB_URL;
if (connectionUrl && !new URL(connectionUrl).pathname.endsWith("_verify_db")) {
  throw new Error("интеграционный тест допускается только на базе *_verify_db");
}
const run = connectionUrl ? describe : describe.skip;

/** Запуск: ORDER_INTEGRATION_DB_URL=postgres://.../order_verify_db npm test -w @food-delivery/order */
run("хранилище заказов на PostgreSQL", () => {
  let db: DataSource;
  let repository: TypeOrmOrderRepository;
  let read: TypeOrmOrderReadModel;
  let place: PlaceOrderUseCase;
  let commands: OrderCommandsUseCase;
  let runner: SagaRunner;
  let participants: ParticipantEventsUseCase;
  let payment: FakePayment;

  beforeAll(async () => {
    db = await new DataSource({ type: "postgres", url: connectionUrl, entities: [] }).initialize();
    repository = new TypeOrmOrderRepository(db);
    read = new TypeOrmOrderReadModel(db);
    const workflow = new OrderWorkflow(TEST_SETTINGS.timeouts);
    const committer = new OrderCommitter(repository, workflow);
    payment = new FakePayment();
    place = new PlaceOrderUseCase(
      repository,
      new FakeCatalog(),
      new InMemoryCartStore(),
      workflow,
      TEST_SETTINGS,
    );
    commands = new OrderCommandsUseCase(repository, committer, () => new Date());
    runner = new SagaRunner(
      repository,
      repository,
      payment,
      new FakeDelivery(),
      workflow,
      committer,
      TEST_SETTINGS,
    );
    participants = new ParticipantEventsUseCase(repository, committer, workflow, TEST_SETTINGS);
  });

  afterAll(async () => {
    await db?.destroy();
  });

  const placeOrder = (key = randomUUID()) =>
    runWithContext({ correlationId: "integration" }, () =>
      place.execute(
        {
          restaurantId: RESTAURANT_ID,
          idempotencyKey: key,
          address: { text: "Москва, Тверская, 1", latitude: 55.7601, longitude: 37.6101 },
          items: [{ itemId: ITEM_ID, quantity: 2 }],
        },
        customer,
      ),
    );

  /** Выполнить наступившие шаги именно этого заказа. */
  const drain = async (orderId: string) => {
    for (let round = 0; round < 10; round += 1) {
      const claimed = (await repository.claimDue(50, 30_000)).filter(
        (entry) => entry.orderId === orderId,
      );
      if (claimed.length === 0) return;
      for (const entry of claimed) await runner.run(entry);
    }
  };

  it("сохраняет заказ со снимками позиций, точками и событиями в outbox одной транзакцией", async () => {
    const { order } = await placeOrder();
    const view = await read.get(order.id);
    expect(view).toMatchObject({
      status: "CREATED",
      location: { latitude: 55.7601, longitude: 37.6101 },
      amounts: { items: 90000, delivery: 15000, total: 105000 },
      lines: [{ name: "Пицца «Маргарита»", quantity: 2, lineTotal: 90000 }],
    });
    const outbox = await db.query(
      `SELECT event_type, headers->>'partitionKey' AS key FROM outbox_messages WHERE aggregate_id = $1`,
      [order.id],
    );
    expect(outbox).toEqual([{ event_type: "OrderStatusChanged", key: order.id }]);
    const loaded = await repository.findById(order.id);
    expect(loaded?.order.pickup).toEqual({ latitude: 55.76, longitude: 37.62 });
    expect(loaded?.saga.correlationId).toBe("integration");
  });

  it("повтор формы с тем же ключом возвращает тот же заказ — уникальный индекс (ORD-4)", async () => {
    const key = randomUUID();
    const [first, second] = await Promise.all([placeOrder(key), placeOrder(key)]);
    expect(first.order.id).toBe(second.order.id);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    const [{ count }] = await db.query(
      `SELECT count(*)::int AS count FROM orders WHERE idempotency_key = $1`,
      [key],
    );
    expect(count).toBe(1);
  });

  it("шаги саги берутся в аренду: второй исполнитель не получит тот же шаг", async () => {
    const { order } = await placeOrder();
    const first = (await repository.claimDue(50, 30_000)).filter((e) => e.orderId === order.id);
    const second = (await repository.claimDue(50, 30_000)).filter((e) => e.orderId === order.id);
    expect(first.map((entry) => entry.type)).toEqual(["AUTHORIZE_PAYMENT"]);
    expect(second).toEqual([]);
    for (const entry of first) await runner.run(entry);
    expect((await read.get(order.id))?.status).toBe("AWAITING_RESTAURANT");
  });

  it("путь до готовки: история переходов, шаги саги, активный срок статуса", async () => {
    const { order } = await placeOrder();
    await drain(order.id);
    await commands.confirm(order.id, kitchen, 15);
    await drain(order.id);

    const history = await read.history(order.id);
    expect(history?.transitions.map((t) => t.to)).toEqual([
      "CREATED",
      "PENDING_PAYMENT",
      "PAID",
      "AWAITING_RESTAURANT",
      "COOKING",
    ]);
    expect(history?.saga?.steps.map((s) => [s.step, s.status])).toEqual([
      ["AUTHORIZE_PAYMENT", "SUCCEEDED"],
      ["CAPTURE_PAYMENT", "SUCCEEDED"],
      ["REQUEST_COURIER", "SUCCEEDED"],
    ]);
    expect(history?.pending.map((p) => p.type)).toEqual(["TIMEOUT:COOKING"]);
    expect((await read.kitchenQueue(RESTAURANT_ID)).some((o) => o.id === order.id)).toBe(true);
  });

  it("одновременное изменение отклоняется по версии (оптимистичная блокировка)", async () => {
    const { order } = await placeOrder();
    await drain(order.id);
    const stale = await repository.findById(order.id);
    await commands.confirm(order.id, kitchen, 10);
    stale!.order.cancel({ type: "CUSTOMER", id: customer.id }, "CUSTOMER", null, new Date());
    const committer = new OrderCommitter(repository, new OrderWorkflow());
    await expect(committer.commit(stale!, new Date())).rejects.toBeInstanceOf(ConflictError);
    expect((await read.get(order.id))?.status).toBe("COOKING");
  });

  it("повторная доставка события отсекается отметкой в inbox_messages (REL-4)", async () => {
    const { order } = await placeOrder();
    await drain(order.id);
    await commands.confirm(order.id, kitchen, 10);
    const loaded = await repository.findById(order.id);
    const committer = new OrderCommitter(repository, new OrderWorkflow());
    const messageId = randomUUID();
    await committer.commit(loaded!, new Date(), {
      inbox: { messageId, consumer: "test", eventType: "X" },
    });
    const again = await repository.findById(order.id);
    await expect(
      committer.commit(again!, new Date(), {
        inbox: { messageId, consumer: "test", eventType: "X" },
      }),
    ).rejects.toBeInstanceOf(DuplicateMessageError);

    // Событие участника через сценарий: повтор тихо пропускается и не ставит
    // второй повторный вызов курьера.
    await drain(order.id);
    const notFound = createEvent({
      eventType: DELIVERY_EVENT_TYPES.courierNotFound,
      aggregateType: "delivery",
      aggregateId: order.id,
      payload: { orderId: order.id, deliveryId: randomUUID(), attempts: 2 },
      correlationId: "integration",
    });
    await expect(participants.onDeliveryEvent(notFound)).resolves.toBe(true);
    await expect(participants.onDeliveryEvent(notFound)).resolves.toBe(false);
    const saga = await repository.findById(order.id);
    expect(saga?.saga.facts.courierSeq).toBe(2);
  });

  it("отмена снимает шаги и сроки и ставит компенсацию; очередь оператора находит заказ", async () => {
    const { order } = await placeOrder();
    await drain(order.id);
    await commands.cancelByCustomer(order.id, customer, "передумал");
    let pending = (await read.history(order.id))?.pending.map((p) => p.type);
    expect(pending).toEqual(["VOID_PAYMENT"]);
    await drain(order.id);
    pending = (await read.history(order.id))?.pending.map((p) => p.type);
    expect(pending).toEqual([]);
    expect(payment.holds(order.id)).toBe(false);
    const cancelled = await read.list({ statuses: ["CANCELLED"], limit: 500, offset: 0 });
    expect(cancelled.some((o) => o.id === order.id)).toBe(true);
  });
});
