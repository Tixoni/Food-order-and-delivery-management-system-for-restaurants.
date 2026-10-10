/**
 * Сквозная проверка сервиса платежей на живых процессах: payment +
 * эмулятор провайдера + PostgreSQL + Kafka. Только localhost.
 *
 * Что проверяется:
 *   1. внутренний API закрыт служебным токеном;
 *   2. двадцать одновременных повторов холда — один платёж у провайдера (PAY-4);
 *   3. списание, частичный и полный возврат; возврат сверх списанного
 *      и снятие холда со списанного отклоняются (PAY-2, PAY-3, PAY-6);
 *   4. отказ банка — штатный ответ DECLINED;
 *   5. потерянный ответ провайдера: повтор с тем же ключом не списывает дважды;
 *   6. размыкатель цепи: при отказах провайдера ответ приходит сразу, без ожидания;
 *   7. поздний холд: вызывающий получил таймаут и не повторил, а сверка
 *      узнала результат и опубликовала PaymentAuthorized (страховка саги);
 *   8. все события — в payment.events с ключом заказа (REL-3);
 *   9. денежная история заказа — одним запросом.
 *
 * Сервис платежей запускается со сверкой раз в 2 с (RECONCILE_INTERVAL_MS=2000,
 * RECONCILE_AFTER_MS=4000) и размыкателем по умолчанию (5 отказов → 10 с).
 *
 * Запуск: PAYMENT_URL=http://localhost:13003 PROVIDER_URL=http://localhost:13010 \
 *         KAFKA_BROKERS=localhost:19092 node infra/verification/payment-e2e.mjs
 */
import { randomUUID } from "node:crypto";
import { Kafka, logLevel } from "kafkajs";

const payment = new URL(process.env.PAYMENT_URL ?? "http://localhost:13003");
const provider = new URL(process.env.PROVIDER_URL ?? "http://localhost:13010");
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:19092").split(",");
const token = process.env.PAYMENT_INTERNAL_TOKEN ?? "payment-internal-dev-token";
if (payment.hostname !== "localhost" || provider.hostname !== "localhost") {
  throw new Error("проверка допускается только на localhost");
}

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}

async function call(base, path, method = "GET", body, headers = {}) {
  const started = performance.now();
  const response = await fetch(new URL(path, base), {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    ms: Math.round(performance.now() - started),
  };
}

const api = (path, body) =>
  call(payment, path, body ? "POST" : "GET", body, { "x-internal-token": token });
const emulator = (settings) => call(provider, "/_emulator/settings", "POST", settings);
const stats = async () => (await call(provider, "/_emulator/stats")).body.performed;
const atProvider = async (orderId) =>
  (await call(provider, `/_emulator/orders/${orderId}/payments`)).body.items;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const customerId = randomUUID();
const authorize = (orderId, amount = 150_000, key = `${orderId}:authorize`) =>
  api("/payments/authorize", {
    orderId,
    customerId,
    amount,
    currency: "RUB",
    idempotencyKey: key,
  });

async function waitUntil(check, timeoutMs) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await check();
    if (value) return value;
    await sleep(250);
  }
  return null;
}

const ordersTouched = [];
const order = () => {
  const id = randomUUID();
  ordersTouched.push(id);
  return id;
};

await emulator({
  failOperation: null,
  loseResponseOperation: null,
  failureRate: 0,
  delayMs: 0,
  declineAbove: null,
});

console.log("1. Доступ к внутреннему API");
{
  const anonymous = await call(payment, "/payments/authorize", "POST", {});
  const forged = await call(
    payment,
    "/payments/authorize",
    "POST",
    {},
    {
      "x-internal-token": "guess",
    },
  );
  check(anonymous.status === 401 && forged.status === 401, "без служебного токена — 401");
}

console.log("2. Двадцать одновременных повторов холда (PAY-4)");
{
  const orderId = order();
  const before = await stats();
  const results = await Promise.all(Array.from({ length: 20 }, () => authorize(orderId)));
  const ids = new Set(results.map((r) => r.body?.paymentId));
  check(
    results.every((r) => r.status === 200 && r.body.status === "AUTHORIZED"),
    "все двадцать ответов — AUTHORIZED",
    results.map((r) => r.status),
  );
  check(ids.size === 1, "один и тот же платёж во всех ответах");
  check((await stats()).create - before.create === 1, "у провайдера ровно один холд");
  check((await atProvider(orderId)).length === 1, "у провайдера один платёж по заказу");
}

console.log("3. Списание и возвраты (PAY-2, PAY-3, PAY-6)");
{
  const orderId = order();
  await authorize(orderId, 100_000);
  const captured = await api("/payments/capture", {
    orderId,
    idempotencyKey: `${orderId}:capture`,
  });
  check(captured.status === 200 && captured.body.status === "CAPTURED", "списано");
  const voidCaptured = await api("/payments/void", {
    orderId,
    idempotencyKey: `${orderId}:void:1`,
  });
  check(voidCaptured.status === 422, "холд со списанного не снимается — 422");
  const partial = await api("/payments/refund", {
    orderId,
    idempotencyKey: `${orderId}:refund:1`,
    amount: 30_000,
  });
  check(
    partial.body?.status === "PARTIALLY_REFUNDED" && partial.body.refundedTotal === 30_000,
    "частичный возврат 300 ₽",
  );
  const over = await api("/payments/refund", {
    orderId,
    idempotencyKey: `${orderId}:refund:2`,
    amount: 70_001,
  });
  check(over.status === 422, "возврат сверх списанного — 422");
  const rest = await api("/payments/refund", {
    orderId,
    idempotencyKey: `${orderId}:refund:3`,
    amount: 70_000,
  });
  check(rest.body?.status === "REFUNDED" && rest.body.refundedTotal === 100_000, "возвращено всё");
  const [atBank] = await atProvider(orderId);
  check(atBank.refunded_amount.value === "1000.00", "у провайдера возвращено 1000.00 ₽ строкой");
}

console.log("4. Отказ банка");
{
  await emulator({ declineAbove: 500_000 });
  const declined = await authorize(order(), 600_000);
  await emulator({ declineAbove: null });
  check(
    declined.status === 200 && declined.body.status === "DECLINED",
    `штатный ответ DECLINED (${declined.body?.declineReason})`,
  );
}

console.log("5. Потерянный ответ провайдера на списании");
{
  const orderId = order();
  await authorize(orderId);
  const before = await stats();
  await emulator({ loseResponseOperation: "capture" });
  const lost = await api("/payments/capture", { orderId, idempotencyKey: `${orderId}:capture` });
  await emulator({ loseResponseOperation: null });
  check(lost.status === 502, "вызывающий получил 502 — повтор осмыслен");
  const retried = await api("/payments/capture", { orderId, idempotencyKey: `${orderId}:capture` });
  check(
    retried.status === 200 && retried.body.status === "CAPTURED",
    "повтор с тем же ключом — CAPTURED",
  );
  check((await stats()).capture - before.capture === 1, "у провайдера одно списание, не два");
}

console.log("6. Размыкатель цепи при отказах провайдера");
{
  await emulator({ failOperation: "create" });
  const timings = [];
  for (let i = 0; i < 8; i += 1) timings.push((await authorize(order(), 1_000)).ms);
  await emulator({ failOperation: null });
  const fast = timings.slice(-3);
  check(
    fast.every((ms) => ms < 100),
    `после серии отказов ответ сразу: последние ${fast.join(", ")} мс`,
    timings,
  );
  const health = await call(payment, "/ready");
  check(health.status === 200, "сам сервис платежей готов — отказал только провайдер (REL-2)");
  // Размыкатель пропустит пробный вызов через 10 с.
  await sleep(10_500);
  const recovered = await authorize(order(), 1_000);
  check(recovered.body?.status === "AUTHORIZED", "после паузы цепь замкнулась, холд проходит");
}

console.log("7. Поздний холд: вызывающий не дождался, сверка узнала результат");
{
  const orderId = order();
  await emulator({ delayMs: 1_500 });
  const slow = await authorize(orderId);
  await emulator({ delayMs: 0 });
  check(slow.status === 504 || slow.status === 502, `вызывающий получил ${slow.status}`);
  const settled = await waitUntil(async () => {
    const history = await api(`/payments/orders/${orderId}`);
    return history.body?.payments?.[0]?.status === "AUTHORIZED" ? history : null;
  }, 20_000);
  check(!!settled, "сверка зафиксировала холд без повтора со стороны вызывающего");
  check((await atProvider(orderId)).length === 1, "у провайдера один платёж — повторы не задвоили");
}

console.log("8. События в payment.events");
{
  const kafka = new Kafka({ clientId: "payment-e2e", brokers, logLevel: logLevel.NOTHING });
  const consumer = kafka.consumer({ groupId: `payment-e2e-${randomUUID()}` });
  const found = [];
  await consumer.connect();
  await consumer.subscribe({ topic: "payment.events", fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString("utf8") ?? "";
      const orderId = ordersTouched.find((id) => value.includes(id));
      if (orderId) found.push({ orderId, key: message.key?.toString(), event: JSON.parse(value) });
    },
  });
  await sleep(6_000);
  await consumer.disconnect();

  const types = found.map((f) => f.event.eventType);
  check(types.includes("PaymentAuthorized"), "PaymentAuthorized опубликован");
  check(types.includes("PaymentCaptured"), "PaymentCaptured опубликован");
  check(types.filter((t) => t === "PaymentRefunded").length === 2, "два события возврата");
  check(types.includes("PaymentFailed"), "PaymentFailed об отказе банка");
  check(
    found.every((f) => f.key === f.orderId),
    "ключ сообщения — заказ: события заказа по порядку",
  );
  const concurrentOrder = ordersTouched[0];
  check(
    found.filter((f) => f.orderId === concurrentOrder && f.event.eventType === "PaymentAuthorized")
      .length === 1,
    "из двадцати повторов — одно событие о холде",
  );
}

console.log("9. Денежная история заказа");
{
  const history = await api(`/payments/orders/${ordersTouched[1]}`);
  const journal = history.body.transactions.map((t) => `${t.type}:${t.status}`);
  check(
    JSON.stringify(journal) ===
      JSON.stringify([
        "AUTHORIZE:SUCCEEDED",
        "CAPTURE:SUCCEEDED",
        "REFUND:SUCCEEDED",
        "REFUND:SUCCEEDED",
      ]),
    `журнал одним запросом: ${journal.join(" → ")}`,
  );
}

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nНе пройдено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
