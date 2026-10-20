/**
 * Сквозная проверка сервиса заказов на живых процессах: catalog + order +
 * PostgreSQL + Kafka + Redis. Только localhost и фиктивные токены
 * (сервисы запущены с AUTH_DISABLED=true).
 *
 * Сценарии (ORDER_E2E_SCENARIO):
 *   happy            — оформление → оплата → кухня → курьер → вручение;
 *                      повтор формы, события в Kafka, повтор события, DLQ;
 *   capture-failure  — платежи отказывают на списании: отзыв у ресторана,
 *                      снятие холда, отмена «техническая». Отказ включается
 *                      у эмулятора провайдера — нужен PROVIDER_URL;
 *   payment-down     — сервис платежей остановлен (REL-2): заказ всё равно
 *                      принимается, а затем отменяется с явной причиной;
 *   timeout-start    — оформить и оставить ждать ресторан (перед перезапуском);
 *   timeout-check    — после перезапуска order: заказ отменён по сроку (REL-6).
 *
 * Запуск: ORDER_URL=http://localhost:13102 CATALOG_URL=http://localhost:13101 \
 *         KAFKA_BROKERS=localhost:29092 [PROVIDER_URL=http://localhost:13010] \
 *         node infra/verification/order-e2e.mjs
 */
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { Kafka, logLevel } from "kafkajs";

const order = new URL(process.env.ORDER_URL ?? "http://localhost:13102");
const catalog = new URL(process.env.CATALOG_URL ?? "http://localhost:13101");
const brokers = (process.env.KAFKA_BROKERS ?? "localhost:29092").split(",");
const scenario = process.env.ORDER_E2E_SCENARIO ?? "happy";
const stateFile = process.env.ORDER_E2E_STATE ?? ".order-e2e-state.json";
/** Эмулятор платёжного провайдера — когда order работает с настоящим сервисом платежей. */
const provider = process.env.PROVIDER_URL ? new URL(process.env.PROVIDER_URL) : null;
if (
  order.hostname !== "localhost" ||
  catalog.hostname !== "localhost" ||
  (provider && provider.hostname !== "localhost")
) {
  throw new Error("проверка с фиктивными токенами допускается только на localhost");
}

const token = (sub, roles, restaurantId) =>
  `e30.${Buffer.from(JSON.stringify({ sub, realm_access: { roles }, restaurantId })).toString("base64url")}.x`;

async function request(base, path, method = "GET", body, accessToken) {
  const started = performance.now();
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    body: text ? JSON.parse(text) : null,
    ms: Math.round(performance.now() - started),
  };
}

async function waitUntil(check, timeoutMs, message) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    const result = await check();
    if (result) return { result, ms: Math.round(performance.now() - started) };
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

function check(condition, message) {
  if (!condition) throw new Error(`ПРОВАЛ: ${message}`);
  console.log(`  ✓ ${message}`);
}

const kafka = new Kafka({ clientId: "order-e2e", brokers, logLevel: logLevel.NOTHING });
const customerId = randomUUID();
const operatorToken = token(randomUUID(), ["operator"]);
const clientToken = token(customerId, ["client"]);

/** Ресторан, который сейчас принимает заказы по адресу, и блюдо из его меню. */
async function pickRestaurant() {
  const points = [
    [55.7558, 37.6176],
    [55.7601, 37.6101],
    [55.7522, 37.5927],
    [55.7299, 37.6034],
    [55.7887, 37.6024],
    [55.7614, 37.6633],
  ];
  for (const [lat, lon] of points) {
    const offers = await request(
      catalog,
      `/restaurants/delivery-to?lat=${lat}&lon=${lon}&limit=20`,
    );
    for (const offer of offers.body?.items ?? []) {
      const orderability = await request(catalog, `/restaurants/${offer.id}/orderability`);
      if (
        !orderability.body?.canOrder &&
        !orderability.body?.orderable &&
        !orderability.body?.isOpen
      )
        continue;
      const menu = await request(catalog, `/restaurants/${offer.id}/menu`);
      const items = (menu.body?.categories ?? []).flatMap((category) => category.items ?? []);
      const item = items.find(
        (candidate) =>
          candidate.isAvailable !== false &&
          (candidate.optionGroups ?? []).every((g) => !g.isRequired),
      );
      if (!item) continue;
      const quantity = Math.max(1, Math.ceil(offer.minOrderAmount / item.price));
      return { restaurantId: offer.id, itemId: item.id, quantity, lat, lon };
    }
  }
  throw new Error("не найден ресторан, который сейчас принимает заказы");
}

async function placeOrder(target, key = randomUUID()) {
  return request(
    order,
    "/orders",
    "POST",
    {
      restaurantId: target.restaurantId,
      idempotencyKey: key,
      address: {
        text: "Москва, проверочный адрес, 1",
        latitude: target.lat,
        longitude: target.lon,
      },
      items: [{ itemId: target.itemId, quantity: target.quantity }],
      comment: "сквозная проверка",
    },
    clientToken,
  );
}

const statusOf = async (orderId) =>
  (await request(order, `/orders/${orderId}`, "GET", null, operatorToken)).body;
const historyOf = async (orderId) =>
  (await request(order, `/orders/${orderId}/history`, "GET", null, operatorToken)).body;
const waitStatus = (orderId, status, timeoutMs = 15_000) =>
  waitUntil(
    async () => (await statusOf(orderId))?.status === status,
    timeoutMs,
    `заказ не перешёл в ${status}`,
  );

async function publishDelivery(type, orderId, payload) {
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  const event = {
    messageId: randomUUID(),
    eventType: type,
    eventVersion: 1,
    aggregateType: "delivery",
    aggregateId: orderId,
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    payload: { orderId, deliveryId: randomUUID(), courierId: randomUUID(), ...payload },
  };
  await producer.send({
    topic: "delivery.events",
    messages: [{ key: orderId, value: JSON.stringify(event) }],
  });
  await producer.disconnect();
  return event;
}

async function readTopic(topic, predicate, timeoutMs = 10_000) {
  const consumer = kafka.consumer({ groupId: `order-e2e-${randomUUID()}` });
  const found = [];
  await consumer.connect();
  await consumer.subscribe({ topic, fromBeginning: true });
  await consumer.run({
    eachMessage: async ({ message }) => {
      const value = message.value?.toString("utf8") ?? "";
      if (predicate(value, message)) found.push({ value, headers: message.headers });
    },
  });
  await new Promise((resolve) => setTimeout(resolve, timeoutMs));
  await consumer.disconnect();
  return found;
}

async function happy() {
  console.log("Сценарий: успешный путь заказа");
  const target = await pickRestaurant();
  const key = randomUUID();
  const placed = await placeOrder(target, key);
  check(
    placed.status === 201,
    `заказ оформлен (201) за ${placed.ms} мс — одиночный запрос, не замер p95`,
  );
  const orderId = placed.body.order.id;

  const replay = await placeOrder(target, key);
  check(
    replay.status === 200 && replay.body.order.id === orderId,
    "повтор формы с тем же ключом вернул тот же заказ (ORD-4)",
  );

  const paid = await waitStatus(orderId, "AWAITING_RESTAURANT");
  check(true, `оплата прошла фоновым шагом саги, заказ у ресторана через ${paid.ms} мс`);

  const kitchenToken = token(randomUUID(), ["kitchen"], target.restaurantId);
  const queue = await request(
    order,
    `/restaurants/${target.restaurantId}/kitchen-queue`,
    "GET",
    null,
    kitchenToken,
  );
  check(
    queue.body.items.some((item) => item.id === orderId),
    "заказ в очереди кухни (KIT-1)",
  );
  const foreign = await request(
    order,
    `/orders/${orderId}`,
    "GET",
    null,
    token(randomUUID(), ["client"]),
  );
  check(foreign.status === 404, "чужой клиент получает «не найден» (SEC-2)");

  const confirmed = await request(
    order,
    `/orders/${orderId}/confirm`,
    "POST",
    { cookingMinutes: 15 },
    kitchenToken,
  );
  check(
    confirmed.status === 200 && confirmed.body.status === "COOKING",
    "кухня приняла заказ (KIT-2)",
  );
  await waitUntil(
    async () => (await historyOf(orderId))?.saga?.facts?.courierRequested === true,
    15_000,
    "сага не дошла до вызова курьера",
  );
  check(true, "списание и вызов курьера выполнены шагами саги");

  const ready = await request(order, `/orders/${orderId}/ready`, "POST", {}, kitchenToken);
  check(ready.body.status === "ASSIGNING_COURIER", "заказ готов, ждёт курьера (KIT-4)");

  await publishDelivery("OrderPickedUp", orderId, {
    pickedUpAt: new Date().toISOString(),
    etaMinutes: 20,
  });
  await waitStatus(orderId, "IN_TRANSIT");
  check(true, "событие доставки «забрал» перевело заказ в «в пути»");

  const completed = await publishDelivery("DeliveryCompleted", orderId, {
    deliveredAt: new Date().toISOString(),
  });
  await waitStatus(orderId, "DELIVERED");
  check(true, "событие «вручил» завершило заказ");

  // Повторная доставка того же события — без последствий.
  const producer = kafka.producer({ allowAutoTopicCreation: false });
  await producer.connect();
  await producer.send({
    topic: "delivery.events",
    messages: [{ key: orderId, value: JSON.stringify(completed) }],
  });
  await producer.send({
    topic: "delivery.events",
    messages: [{ key: "broken", value: "{не json" }],
  });
  await producer.disconnect();

  const history = await historyOf(orderId);
  check(
    JSON.stringify(history.transitions.map((t) => t.to)) ===
      JSON.stringify([
        "CREATED",
        "PENDING_PAYMENT",
        "PAID",
        "AWAITING_RESTAURANT",
        "COOKING",
        "READY",
        "ASSIGNING_COURIER",
        "IN_TRANSIT",
        "DELIVERED",
      ]),
    "история переходов полная и по порядку",
  );
  check(
    history.saga.status === "COMPLETED" && history.pending.length === 0,
    "сага завершена, висящих таймеров нет (REL-6)",
  );

  const events = await readTopic("order.events", (value) => value.includes(orderId));
  const types = events.map((event) => JSON.parse(event.value).eventType);
  check(
    types.includes("OrderPlaced") && types.includes("OrderDelivered"),
    `события заказа в Kafka: ${types.length} шт.`,
  );
  const correlations = new Set(events.map((event) => JSON.parse(event.value).correlationId));
  const placedEvent = events
    .map((e) => JSON.parse(e.value))
    .find((e) => e.eventType === "OrderPlaced");
  const firstEvent = events.map((e) => JSON.parse(e.value))[0];
  check(
    placedEvent.correlationId === firstEvent.correlationId,
    "фоновые шаги саги продолжают сквозной идентификатор оформления (OBS-2)",
  );
  check(correlations.size >= 1, "у событий есть сквозной идентификатор");
  check(
    events.every((event) => event.headers && event.value),
    "события несут ключ заказа и заголовки",
  );

  const dlq = await readTopic("delivery.events.dlq", (value) => value.includes("не json"), 6000);
  check(
    dlq.length >= 1,
    "испорченное сообщение ушло в delivery.events.dlq, чтение топика не остановилось",
  );
  const after = await statusOf(orderId);
  check(after.status === "DELIVERED", "повтор события «вручил» ничего не изменил (REL-4)");
}

async function captureFailure() {
  console.log("Сценарий: отказ платёжного сервиса на списании (REL-5)");
  if (!provider)
    throw new Error("сценарий capture-failure требует PROVIDER_URL эмулятора провайдера");
  const target = await pickRestaurant();
  const placed = await placeOrder(target);
  const orderId = placed.body.order.id;
  await waitStatus(orderId, "AWAITING_RESTAURANT");
  const kitchenToken = token(randomUUID(), ["kitchen"], target.restaurantId);
  // Отказ провайдера на списании включается только сейчас: холд уже прошёл.
  await request(provider, "/_emulator/settings", "POST", { failOperation: "capture" });
  const startedAt = performance.now();
  await request(order, `/orders/${orderId}/confirm`, "POST", { cookingMinutes: 15 }, kitchenToken);
  let done;
  try {
    done = await waitUntil(
      async () => {
        const history = await historyOf(orderId);
        return history?.saga?.status === "FAILED" ? history : null;
      },
      60_000,
      "система не пришла в согласованное состояние за 60 с",
    );
  } finally {
    await request(provider, "/_emulator/settings", "POST", { failOperation: null });
  }
  const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
  const final = await statusOf(orderId);
  check(
    final.status === "CANCELLED" && final.cancelReason === "TECHNICAL",
    "заказ отменён с причиной «техническая»",
  );
  const steps = done.result.saga.steps.map((s) => `${s.step}:${s.status}`);
  check(
    steps.filter((s) => s === "CAPTURE_PAYMENT:FAILED").length >= 2,
    "списание повторялось с задержкой",
  );
  check(steps.includes("VOID_PAYMENT:SUCCEEDED"), "холд снят — деньги клиента возвращены");
  const atProvider = await request(provider, `/_emulator/orders/${orderId}/payments`);
  check(
    atProvider.body.items.length === 1 && atProvider.body.items[0].status === "canceled",
    "у провайдера ровно один платёж по заказу, холд отменён — деньги не списаны",
  );
  check(done.result.pending.length === 0, "висящих шагов и таймеров нет");
  const events = await readTopic("order.events", (value) => value.includes(orderId), 6000);
  const types = events.map((event) => JSON.parse(event.value).eventType);
  check(types.includes("OrderRecalled"), "ресторану отправлен отзыв заказа (OrderRecalled)");
  check(Number(seconds) <= 60, `согласованное состояние за ${seconds} с — REL-5 ≤ 60 с`);
}

async function paymentDown() {
  console.log("Сценарий: сервис платежей недоступен (REL-2)");
  const target = await pickRestaurant();
  const placed = await placeOrder(target);
  check(placed.status === 201, `заказ принят (201) за ${placed.ms} мс — приём не ждёт платежей`);
  const orderId = placed.body.order.id;

  const catalogAlive = await request(catalog, "/ready");
  check(catalogAlive.status === 200, "каталог работает — отказ платежей его не затронул");

  // Холд повторяется с нарастающей задержкой, затем заказ отменяется.
  const { ms } = await waitUntil(
    async () => (await statusOf(orderId))?.status === "CANCELLED",
    120_000,
    "заказ не отменён за 120 с",
  );
  const final = await statusOf(orderId);
  check(
    final.cancelReason === "TECHNICAL" && /оплата не прошла/.test(final.cancelComment ?? ""),
    `отменён с явной причиной: «${final.cancelComment}» через ${(ms / 1000).toFixed(1)} с`,
  );
  // Снятие холда «на всякий случай» будет повторяться, пока сервис платежей
  // не вернётся: деньги клиента должны быть отпущены наверняка.
  const history = await historyOf(orderId);
  const steps = history.saga.steps.map((step) => step.step);
  check(
    steps.filter((step) => step === "AUTHORIZE_PAYMENT").length >= 2,
    "холд повторялся, прежде чем заказ отменили",
  );
  writeFileSync(stateFile, JSON.stringify({ orderId }));
}

async function timeoutStart() {
  console.log("Сценарий: таймер ресторана до перезапуска");
  const target = await pickRestaurant();
  const placed = await placeOrder(target);
  await waitStatus(placed.body.order.id, "AWAITING_RESTAURANT");
  writeFileSync(stateFile, JSON.stringify({ orderId: placed.body.order.id }));
  check(true, "заказ ждёт ресторан; теперь сервис заказов можно остановить");
}

async function timeoutCheck() {
  console.log("Сценарий: таймер после перезапуска сервиса (REL-6, KIT-5)");
  const { orderId } = JSON.parse(readFileSync(stateFile, "utf8"));
  await waitStatus(orderId, "CANCELLED", 30_000);
  const final = await statusOf(orderId);
  check(
    final.cancelReason === "TIMEOUT",
    "после перезапуска сработал таймер из базы: отмена по сроку",
  );
  // Снятие холда — следующий шаг саги после отмены: ждём, пока сага завершится.
  const { result: history } = await waitUntil(
    async () => {
      const current = await historyOf(orderId);
      return current?.saga?.status === "FAILED" ? current : null;
    },
    15_000,
    "компенсация после отмены по сроку не завершилась",
  );
  check(history.saga.facts.paymentVoided === true, "холд снят, сага завершена");
  check(history.pending.length === 0, "висящих шагов и таймеров нет");
}

const scenarios = {
  happy,
  "capture-failure": captureFailure,
  "payment-down": paymentDown,
  "timeout-start": timeoutStart,
  "timeout-check": timeoutCheck,
};
try {
  await scenarios[scenario]();
  console.log("Готово.");
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
