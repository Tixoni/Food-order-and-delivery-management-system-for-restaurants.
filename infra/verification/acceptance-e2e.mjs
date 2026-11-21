import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { createClient } from "graphql-ws";
import pg from "pg";

const base = new URL(process.env.GATEWAY_URL ?? "http://localhost:13080");
const realtime = new URL("/graphql", process.env.GATEWAY_WS_URL ?? base);
for (const url of [base, realtime]) {
  assert(["localhost", "127.0.0.1"].includes(url.hostname), "нужен локальный тестовый стенд");
}
realtime.protocol = realtime.protocol === "https:" ? "wss:" : "ws:";
const connectionCount = Number(process.env.CLIENTS ?? 1);
const samples = Number(process.env.SAMPLES ?? 20);
assert(Number.isInteger(connectionCount) && connectionCount > 0 && connectionCount <= 200);
assert(Number.isInteger(samples) && samples > 0 && samples <= 200);
const address = { text: "Москва, Тверская", latitude: 55.7615, longitude: 37.6094 };

async function login(role) {
  const response = await fetch(new URL("/auth/login", base), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: `${role}@food.local`,
      password: process.env[`${role.toUpperCase()}_PASSWORD`] ?? role,
    }),
    signal: AbortSignal.timeout(5000),
  });
  const body = await response.json();
  assert(response.ok && body.user?.roles.includes(role), `вход ${role}: HTTP ${response.status}`);
  return body;
}

async function query(session, document, variables = {}, allowErrors = false) {
  const response = await fetch(new URL("/graphql", base), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(session ? { authorization: `Bearer ${session.accessToken}` } : {}),
    },
    body: JSON.stringify({ query: document, variables }),
    signal: AbortSignal.timeout(5000),
  });
  assert(response.ok, `GraphQL: HTTP ${response.status}`);
  const body = await response.json();
  if (allowErrors) return body;
  assert(!body.errors, body.errors?.map(({ message }) => message).join("; "));
  return body.data;
}

async function until(message, check, timeout = 20_000) {
  const ends = Date.now() + timeout;
  do {
    const result = await check();
    if (result) return result;
    await sleep(150);
  } while (Date.now() < ends);
  throw new Error(message);
}

const status = async (session, id) =>
  (await query(session, "query ($id: ID!) { order(id: $id) { status } }", { id })).order.status;
const list = "query ($number: Int!) { operatorOrders(number: $number) { id orderNumber status } }";
const cancel =
  'mutation ($id: ID!, $refund: Int) { operatorCancelOrder(id: $id, reason: "Проверка поддержки", refundAmount: $refund) { status cancelComment } }';
const shift = "mutation ($on: Boolean!) { setCourierShift(onShift: $on) { status } }";
const move =
  "mutation ($latitude: Float!, $longitude: Float!) { updateCourierLocation(latitude: $latitude, longitude: $longitude) }";

const [client, kitchen, courier, operator, admin] = await Promise.all(
  ["client", "kitchen", "courier", "operator", "admin"].map(login),
);
const { restaurantsNearby } = await query(
  null,
  "query ($lat: Float!, $lon: Float!) { restaurantsNearby(latitude: $lat, longitude: $lon) { id name minOrderAmount } }",
  { lat: address.latitude, lon: address.longitude },
);
const restaurant = restaurantsNearby.find(({ id }) => id === kitchen.user.restaurantId);
assert(restaurant, "ресторан кухни отсутствует по адресу Тверская. Выполните npm run auth:bind");
const { menu } = await query(
  null,
  "query ($id: ID!) { menu(restaurantId: $id, includeUnavailable: false) { categories { items { id price optionGroups { id } } } } }",
  { id: restaurant.id },
);
const items = [];
let total = 0;
for (const dish of menu.categories.flatMap(({ items: dishes }) => dishes)) {
  if (dish.optionGroups.length) continue;
  items.push({ itemId: dish.id, quantity: 1 });
  total += dish.price;
  if (total >= restaurant.minOrderAmount) break;
}
assert(items.length && total >= restaurant.minOrderAmount, "нет подходящего тестового меню");

async function placeOrder() {
  const { placeOrder: result } = await query(
    client,
    "mutation ($input: PlaceOrderInput!) { placeOrder(input: $input) { order { id orderNumber } } }",
    {
      input: {
        restaurantId: restaurant.id,
        idempotencyKey: randomUUID(),
        address,
        contactPhone: "+7 900 000-00-00",
        comment: "Проверка приёмки",
        items,
      },
    },
  );
  return result.order;
}

async function confirmOrder(order) {
  await until("заказ не появился на кухне", async () =>
    (await query(kitchen, "query { kitchenQueue { id } }")).kitchenQueue.some(
      ({ id }) => id === order.id,
    ),
  );
  await query(
    kitchen,
    "mutation ($id: ID!) { confirmOrder(id: $id, cookingMinutes: 15) { status } }",
    { id: order.id },
  );
}

async function verifyTracking(order, origin) {
  const received = new Map();
  const subscribers = [];
  const errors = [];
  try {
    for (let i = 0; i < connectionCount; i += 1) {
      const ws = createClient({
        url: realtime.href,
        connectionParams: { authorization: `Bearer ${client.accessToken}` },
        retryAttempts: 0,
      });
      subscribers.push(ws);
      ws.subscribe(
        {
          query: "subscription ($id: ID!) { courierPositionUpdated(orderId: $id) { latitude } }",
          variables: { id: order.id },
        },
        {
          next: ({ data, errors: failures }) => {
            if (failures) errors.push(...failures);
            const point = data?.courierPositionUpdated;
            if (!point) return;
            const key = point.latitude.toFixed(7);
            const current = received.get(key);
            if (current) current.set(i, performance.now());
          },
          error: (failure) => errors.push(failure),
          complete: () => undefined,
        },
      );
      // Измеряем доставку при одновременных подписках, подключая клиентов группами.
      if ((i + 1) % 5 === 0) await sleep(700);
    }

    async function point(latitude) {
      const key = latitude.toFixed(7);
      const seen = new Map();
      received.set(key, seen);
      const started = performance.now();
      const result = await query(courier, move, { latitude, longitude: origin.longitude });
      assert(result.updateCourierLocation, "позиция не принята");
      return { seen, started };
    }
    let ready = 0;
    for (let attempt = 0; attempt < 20 && ready < connectionCount; attempt += 1) {
      assert(errors.length === 0, errors[0]?.message ?? errors[0]?.reason ?? String(errors[0]));
      const { seen } = await point(origin.latitude + attempt * 0.00001);
      await sleep(350);
      ready = seen.size;
    }
    assert.equal(ready, connectionCount, "не все соединения получили прогревочную координату");

    const delays = [];
    for (let i = 0; i < samples; i += 1) {
      const { seen, started } = await point(origin.latitude + 0.001 + i * 0.00001);
      await until("потеря координаты", () => seen.size === connectionCount, 2000);
      delays.push(Math.max(...seen.values()) - started);
    }
    delays.sort((left, right) => left - right);
    assert(errors.length === 0, errors[0]?.message ?? errors[0]?.reason ?? String(errors[0]));
    assert(delays.at(-1) <= 2000, "PERF-3: задержка превысила 2 с");
    const p95 = delays[Math.ceil(delays.length * 0.95) - 1];
    console.log(
      `WebSocket: ${connectionCount} соединений, ${samples}/${samples} координат, p95 ${p95.toFixed(1)} мс, максимум ${delays.at(-1).toFixed(1)} мс`,
    );
  } finally {
    await Promise.all(subscribers.map((ws) => ws.dispose()));
  }
}

const { courierDashboard } = await query(
  courier,
  "query { courierDashboard { courier { status } position { latitude longitude } } }",
);
const origin = courierDashboard.position;
assert(origin, "нет позиции курьера, выполните npm run auth:bind");
assert(["offline", "available"].includes(courierDashboard.courier.status), "тестовый курьер занят");
const wasOnShift = courierDashboard.courier.status === "available";
const active = new Set();
const payments = new pg.Client({
  host: "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER ?? "app",
  password: process.env.POSTGRES_PASSWORD ?? "app",
  database: process.env.PAYMENT_DB ?? "payment_db",
  connectionTimeoutMillis: 5000,
});
await payments.connect();
async function payment(orderId) {
  const { rows } = await payments.query(
    "SELECT status, refunded_amount FROM payments WHERE order_id = $1 ORDER BY created_at DESC LIMIT 1",
    [orderId],
  );
  return rows[0];
}

try {
  await query(courier, shift, { on: true });
  await query(courier, move, origin);
  const delivered = await placeOrder();
  active.add(delivered.id);
  await confirmOrder(delivered);
  const offer = await until("курьер не получил предложение", async () => {
    const { courierDashboard: state } = await query(
      courier,
      "query { courierDashboard { offer { id delivery { orderId contactPhone } } } }",
    );
    return state.offer?.delivery.orderId === delivered.id ? state.offer : null;
  });
  assert.equal(offer.delivery.contactPhone, null, "телефон доступен до принятия предложения");
  const { acceptOffer } = await query(
    courier,
    "mutation ($id: ID!) { acceptOffer(id: $id) { id contactPhone } }",
    { id: offer.id },
  );
  assert(acceptOffer.contactPhone, "после принятия телефон недоступен");
  await query(kitchen, "mutation ($id: ID!) { markOrderReady(id: $id) { status } }", {
    id: delivered.id,
  });
  await query(courier, "mutation ($id: ID!) { markPickedUp(deliveryId: $id) { status } }", {
    id: acceptOffer.id,
  });
  await until(
    "заказ не перешёл в доставку",
    async () => (await status(client, delivered.id)) === "IN_TRANSIT",
  );
  await verifyTracking(delivered, origin);
  await query(courier, "mutation ($id: ID!) { markDelivered(deliveryId: $id) { status } }", {
    id: acceptOffer.id,
  });
  await until(
    "клиент не видит вручение",
    async () => (await status(client, delivered.id)) === "DELIVERED",
  );
  active.delete(delivered.id);
  console.log(`Клиент → кухня → курьер → вручён: №${delivered.orderNumber}`);

  const cancelled = await placeOrder();
  active.add(cancelled.id);
  await confirmOrder(cancelled);
  await until(
    "оплата для проверки возврата не списалась",
    async () => (await payment(cancelled.id))?.status === "CAPTURED",
  );
  const filter = { number: cancelled.orderNumber };
  assert.equal((await query(operator, list, filter)).operatorOrders[0]?.id, cancelled.id);
  assert.equal((await query(admin, list, filter)).operatorOrders[0]?.id, cancelled.id);
  assert(
    (await query(client, list, filter, true)).errors?.length,
    "клиенту доступна очередь оператора",
  );
  const cancellation = await query(operator, cancel, { id: cancelled.id, refund: 100 });
  assert.equal(cancellation.operatorCancelOrder.status, "CANCELLED");
  assert.equal(cancellation.operatorCancelOrder.cancelComment, "Проверка поддержки");
  active.delete(cancelled.id);
  const history = await query(
    operator,
    "query ($id: ID!) { orderTransitions(id: $id) { from to actorType at } }",
    { id: cancelled.id },
  );
  assert.equal(history.orderTransitions.at(-1)?.actorType, "OPERATOR");
  assert.equal(history.orderTransitions.at(-1)?.to, "CANCELLED");
  assert.equal(await status(client, cancelled.id), "CANCELLED");
  await until(
    "частичный возврат не выполнен",
    async () => (await payment(cancelled.id))?.refunded_amount === 100,
  );
  console.log(`Поиск, история, отмена оператором и возврат 100 коп.: №${cancelled.orderNumber}`);
} finally {
  for (const id of active) {
    await query(operator, cancel, { id }).catch(() => undefined);
  }
  await query(courier, move, origin).catch(() => undefined);
  if (!wasOnShift) await query(courier, shift, { on: false }).catch(() => undefined);
  await payments.end();
}
