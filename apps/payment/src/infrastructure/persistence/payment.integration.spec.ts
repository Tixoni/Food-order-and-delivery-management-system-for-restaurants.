import "reflect-metadata";
import { randomUUID } from "node:crypto";
import { DataSource } from "typeorm";
import { PAYMENT_EVENT_TYPES } from "@food-delivery/contracts";
import { ConflictError, DomainRuleError, runWithContext } from "@food-delivery/shared";
import { FakeProvider } from "../../application/use-cases/in-memory.doubles";
import { PaymentOperationsUseCase } from "../../application/use-cases/payment-operations.use-case";
import { SqlPaymentRepository } from "./sql-payment.repository";

const connectionUrl = process.env.PAYMENT_INTEGRATION_DB_URL;
if (connectionUrl && !new URL(connectionUrl).pathname.endsWith("_verify_db")) {
  throw new Error("интеграционный тест допускается только на базе *_verify_db");
}
const run = connectionUrl ? describe : describe.skip;

/**
 * Свойства, которые держит СУБД, а не код: уникальные ключи идемпотентности,
 * «не больше одного действующего платежа на заказ», завершение операции
 * под блокировкой и событие в той же транзакции.
 *
 * Запуск: PAYMENT_INTEGRATION_DB_URL=postgres://.../payment_verify_db \
 *         npm test -w @food-delivery/payment -- payment.integration
 */
run("хранилище платежей на PostgreSQL", () => {
  let db: DataSource;
  let provider: FakeProvider;
  let payments: PaymentOperationsUseCase;
  let repository: SqlPaymentRepository;

  const customerId = randomUUID();
  const authorize = (orderId: string, key = `${orderId}:authorize`, amount = 150_000) =>
    runWithContext({ correlationId: "integration" }, () =>
      payments.authorize({ orderId, customerId, amount, currency: "RUB", idempotencyKey: key }),
    );

  const count = async (sql: string, parameters: unknown[]) =>
    Number((await db.query(sql, parameters))[0].count);

  const outboxOf = (orderId: string, type: string) =>
    count(
      `SELECT count(*) FROM outbox_messages
        WHERE event_type = $2 AND headers->>'partitionKey' = $1`,
      [orderId, type],
    );

  beforeAll(async () => {
    db = await new DataSource({ type: "postgres", url: connectionUrl, entities: [] }).initialize();
    repository = new SqlPaymentRepository(db);
  });

  beforeEach(() => {
    provider = new FakeProvider();
    payments = new PaymentOperationsUseCase(repository, provider, { inFlightMs: 0 });
  });

  afterAll(async () => {
    await db?.destroy();
  });

  it("двадцать одновременных повторов холда — один платёж, одна операция, одно событие (PAY-4)", async () => {
    const orderId = randomUUID();
    provider.delayMs = 10;

    const results = await Promise.all(Array.from({ length: 20 }, () => authorize(orderId)));

    expect(new Set(results.map((r) => r.paymentId)).size).toBe(1);
    expect(provider.moved.hold).toBe(1);
    expect(await count(`SELECT count(*) FROM payments WHERE order_id = $1`, [orderId])).toBe(1);
    expect(
      await count(
        `SELECT count(*) FROM payment_transactions t JOIN payments p ON p.id = t.payment_id
          WHERE p.order_id = $1 AND t.status = 'SUCCEEDED'`,
        [orderId],
      ),
    ).toBe(1);
    expect(await outboxOf(orderId, PAYMENT_EVENT_TYPES.authorized)).toBe(1);
  });

  it("двадцать одновременных повторов списания — одно списание и одно событие", async () => {
    const orderId = randomUUID();
    await authorize(orderId);
    provider.delayMs = 10;

    await Promise.all(
      Array.from({ length: 20 }, () =>
        payments.capture({ orderId, idempotencyKey: `${orderId}:capture` }),
      ),
    );

    expect(provider.moved.capture).toBe(1);
    expect(await outboxOf(orderId, PAYMENT_EVENT_TYPES.captured)).toBe(1);
  });

  it("второй действующий платёж по заказу с другим ключом — конфликт", async () => {
    const orderId = randomUUID();
    await authorize(orderId, `${orderId}:first`);
    await expect(authorize(orderId, `${orderId}:second`)).rejects.toThrow(ConflictError);
    expect(await count(`SELECT count(*) FROM payments WHERE order_id = $1`, [orderId])).toBe(1);
  });

  it("одновременные возвраты с разными ключами не возвращают больше списанного", async () => {
    const orderId = randomUUID();
    await authorize(orderId, `${orderId}:authorize`, 10_000);
    await payments.capture({ orderId, idempotencyKey: `${orderId}:capture` });

    const outcomes = await Promise.allSettled([
      payments.refund({ orderId, idempotencyKey: `${orderId}:refund:1`, amount: 6_000 }),
      payments.refund({ orderId, idempotencyKey: `${orderId}:refund:2`, amount: 6_000 }),
    ]);

    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(DomainRuleError);
    const [payment] = await db.query(`SELECT refunded_amount FROM payments WHERE order_id = $1`, [
      orderId,
    ]);
    expect(Number(payment.refunded_amount)).toBe(6_000);
  });

  it("вся денежная история заказа — одним запросом, в порядке операций", async () => {
    const orderId = randomUUID();
    await authorize(orderId, `${orderId}:authorize`, 10_000);
    await payments.capture({ orderId, idempotencyKey: `${orderId}:capture` });
    await payments.refund({ orderId, idempotencyKey: `${orderId}:refund:1`, amount: 3_000 });
    await payments.refund({ orderId, idempotencyKey: `${orderId}:refund:2`, amount: 7_000 });

    const history = await repository.history(orderId);

    expect(history.payments).toHaveLength(1);
    expect(history.payments[0]).toMatchObject({ status: "REFUNDED", refundedAmount: 10_000 });
    expect(history.transactions.map((t) => `${t.type}:${t.status}`)).toEqual([
      "AUTHORIZE:SUCCEEDED",
      "CAPTURE:SUCCEEDED",
      "REFUND:SUCCEEDED",
      "REFUND:SUCCEEDED",
    ]);
  });

  it("сверка доводит операцию, ответ на которую был потерян", async () => {
    const orderId = randomUUID();
    provider.failNext = "after";
    await expect(authorize(orderId)).rejects.toThrow();

    const pending = (await repository.pending(0, 60 * 60 * 1000, 1000)).filter(
      (operation) => operation.payment.snapshot.orderId === orderId,
    );
    expect(pending).toHaveLength(1);

    await payments.reconcile(pending[0]);

    expect(provider.moved.hold).toBe(1);
    expect(await outboxOf(orderId, PAYMENT_EVENT_TYPES.authorized)).toBe(1);
    const [row] = await db.query(`SELECT status FROM payments WHERE order_id = $1`, [orderId]);
    expect(row.status).toBe("AUTHORIZED");
  });
});
