/**
 * Сквозная проверка доставки на живых процессах: catalog + order + payment
 * + delivery + PostgreSQL/PostGIS + Kafka + Redis. Только localhost и
 * фиктивные токены (сервисы запущены с AUTH_DISABLED=true).
 *
 * Сценарий:
 *   1. два курьера выходят на смену у ресторана и шлют координаты;
 *   2. клиент оформляет заказ, кухня принимает — сага зовёт курьера;
 *   3. ближнему курьеру уходит предложение; он молчит — по истечении срока
 *      заказ уходит второму (DLV-4); цепочка видна в таблице предложений;
 *   4. второй принимает; клиент видит его позицию, чужой клиент — нет (SEC-7);
 *      замер задержки координаты от курьера до канала заказа (PERF-3);
 *   5. «забрал» и «доставил» — заказ доходит до DELIVERED по событиям;
 *   6. второй заказ отменяет оператор — курьер освобождается (компенсация).
 *
 * Сервис доставки запускается с коротким сроком предложения:
 * OFFER_TTL_SECONDS=5, LOCATION_FLUSH_INTERVAL_MS=1000.
 *
 * Запуск: ORDER_URL=http://localhost:13102 CATALOG_URL=http://localhost:13101 \
 *         DELIVERY_URL=http://localhost:13104 REDIS_PORT=26379 POSTGRES_PORT=25432 \
 *         node infra/verification/delivery-e2e.mjs
 */
import { randomUUID } from "node:crypto";
import pg from "pg";
import Redis from "ioredis";

const order = new URL(process.env.ORDER_URL ?? "http://localhost:13102");
const catalog = new URL(process.env.CATALOG_URL ?? "http://localhost:13101");
const delivery = new URL(process.env.DELIVERY_URL ?? "http://localhost:13104");
for (const url of [order, catalog, delivery]) {
  if (url.hostname !== "localhost") {
    throw new Error("проверка с фиктивными токенами допускается только на localhost");
  }
}
const pgConfig = {
  host: "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: "app",
  password: "app",
};

const token = (sub, roles, restaurantId) =>
  `e30.${Buffer.from(JSON.stringify({ sub, realm_access: { roles }, restaurantId })).toString("base64url")}.x`;

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}

async function call(base, path, method = "GET", body, accessToken) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(probe, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe();
    if (value) return value;
    await sleep(250);
  }
  throw new Error(`не дождались: ${message}`);
}

/** Точка в `meters` к северу. */
const north = (from, meters) => ({
  latitude: from.latitude + meters / 111_195,
  longitude: from.longitude,
});

const customerId = randomUUID();
const clientToken = token(customerId, ["client"]);
const operatorToken = token(randomUUID(), ["operator"]);
const adminToken = token(randomUUID(), ["admin"]);

/* ─────────── Ресторан, который сейчас принимает заказы ─────────── */
async function pickRestaurant() {
  const points = [
    [55.7558, 37.6176],
    [55.7601, 37.6101],
    [55.7522, 37.5927],
    [55.7299, 37.6034],
  ];
  for (const [lat, lon] of points) {
    const offers = await call(catalog, `/restaurants/delivery-to?lat=${lat}&lon=${lon}&limit=20`);
    for (const offer of offers.body?.items ?? []) {
      const open = await call(catalog, `/restaurants/${offer.id}/orderability`);
      if (!open.body?.canOrder && !open.body?.orderable && !open.body?.isOpen) continue;
      const menu = await call(catalog, `/restaurants/${offer.id}/menu`);
      const item = (menu.body?.categories ?? [])
        .flatMap((category) => category.items ?? [])
        .find((i) => i.isAvailable !== false && (i.optionGroups ?? []).every((g) => !g.isRequired));
      if (!item) continue;
      return {
        restaurantId: offer.id,
        itemId: item.id,
        quantity: Math.max(1, Math.ceil(offer.minOrderAmount / item.price)),
        dropoff: { latitude: lat, longitude: lon },
      };
    }
  }
  throw new Error("не найден ресторан, который сейчас принимает заказы");
}

const target = await pickRestaurant();
const catalogDb = new pg.Client({ ...pgConfig, database: "catalog_db" });
await catalogDb.connect();
const {
  rows: [restaurant],
} = await catalogDb.query(
  `SELECT name, ST_Y(location::geometry) AS lat, ST_X(location::geometry) AS lon
     FROM restaurants WHERE id = $1`,
  [target.restaurantId],
);
await catalogDb.end();
const pickup = { latitude: Number(restaurant.lat), longitude: Number(restaurant.lon) };
console.log(`Ресторан «${restaurant.name}»\n`);

const deliveryDb = new pg.Client({ ...pgConfig, database: "delivery_db" });
await deliveryDb.connect();
// Курьеры прошлых прогонов не должны оказаться ближе нынешних.
await deliveryDb.query(`UPDATE couriers SET status = 'offline' WHERE status = 'available'`);

/* ─────────── 1. Курьеры на смене ─────────── */
console.log("1. Курьеры выходят на смену у ресторана (DLV-1, DLV-2)");
async function courier(name, meters) {
  const userId = randomUUID();
  const created = await call(
    delivery,
    "/couriers",
    "POST",
    { fullName: name, vehicleType: "bike", userId },
    adminToken,
  );
  const courierToken = token(userId, ["courier"]);
  await call(delivery, "/couriers/me/shift", "POST", { onShift: true }, courierToken);
  const at = north(pickup, meters);
  const sent = await call(delivery, "/couriers/me/location", "POST", at, courierToken);
  return { id: created.body.id, token: courierToken, at, accepted: sent.status === 202 };
}
const near = await courier("Ближний курьер (проверка)", 250);
const far = await courier("Дальний курьер (проверка)", 900);
check(near.id && far.id, "администратор завёл двух курьеров (ADM-2)");
check(near.accepted && far.accepted, "координаты на смене приняты");
await sleep(1500); // пакетная запись истории обновляет позицию для подбора

/* ─────────── 2. Заказ и подтверждение кухней ─────────── */
console.log("2. Заказ оформлен, кухня приняла — сага зовёт курьера");
async function placeAndConfirm() {
  const placed = await call(
    order,
    "/orders",
    "POST",
    {
      restaurantId: target.restaurantId,
      idempotencyKey: randomUUID(),
      address: { text: "проверочный адрес", ...target.dropoff },
      items: [{ itemId: target.itemId, quantity: target.quantity }],
    },
    clientToken,
  );
  const orderId = placed.body.order.id;
  await waitUntil(
    async () =>
      (await call(order, `/orders/${orderId}`, "GET", null, clientToken)).body?.status ===
      "AWAITING_RESTAURANT",
    20_000,
    "оплата заказа",
  );
  const kitchen = token(randomUUID(), ["kitchen"], target.restaurantId);
  await call(order, `/orders/${orderId}/confirm`, "POST", { cookingMinutes: 15 }, kitchen);
  return { orderId, kitchen };
}
const { orderId, kitchen } = await placeAndConfirm();
check(true, `заказ ${orderId.slice(0, 8)} готовится`);

/* ─────────── 3. Предложение и переназначение ─────────── */
console.log("3. Предложение ближнему; молчание — следующему (DLV-3, DLV-4)");
const nearOffer = await waitUntil(
  async () => (await call(delivery, "/couriers/me", "GET", null, near.token)).body?.offer,
  15_000,
  "предложение ближнему курьеру",
);
check(nearOffer.sequence === 1, "ближнему курьеру ушло первое предложение");
const silenceStarted = Date.now();
const farOffer = await waitUntil(
  async () => (await call(delivery, "/couriers/me", "GET", null, far.token)).body?.offer,
  20_000,
  "предложение второму курьеру",
);
check(
  farOffer.sequence === 2,
  `после молчания заказ ушёл второму через ${((Date.now() - silenceStarted) / 1000).toFixed(1)} с`,
);
const late = await call(delivery, `/offers/${nearOffer.id}/accept`, "POST", {}, near.token);
check(late.status === 409, "ближний курьер опоздал: принять просроченное нельзя (409)");
const { rows: chain } = await deliveryDb.query(
  `SELECT a.sequence, a.response FROM delivery_assignments a
     JOIN deliveries d ON d.id = a.delivery_id
    WHERE d.order_id = $1 ORDER BY a.sequence`,
  [orderId],
);
check(
  chain.map((r) => `${r.sequence}:${r.response ?? "open"}`).join(" ") === "1:TIMEOUT 2:open",
  `цепочка предложений: ${chain.map((r) => `${r.sequence}:${r.response ?? "open"}`).join(" → ")}`,
);

/* ─────────── 4. Принял; позиция для клиента ─────────── */
console.log("4. Второй курьер принял; позиция видна только клиенту заказа (TRK-2, SEC-7)");
const accepted = await call(delivery, `/offers/${farOffer.id}/accept`, "POST", {}, far.token);
check(accepted.body?.status === "ASSIGNED", "курьер принял заказ");

const redis = new Redis({ host: "localhost", port: Number(process.env.REDIS_PORT ?? 16379) });
const latencies = [];
await redis.subscribe(`ws:order:${orderId}`);
const received = new Map();
redis.on("message", (_channel, message) => {
  const payload = JSON.parse(message);
  received.set(payload.at, Date.now());
});
for (let i = 0; i < 10; i += 1) {
  const sentAt = Date.now();
  const point = north(far.at, -i * 80);
  await call(delivery, "/couriers/me/location", "POST", point, far.token);
  await waitUntil(
    async () => [...received.values()].some((t) => t >= sentAt),
    2000,
    "координата в канале",
  );
  latencies.push(Math.max(...[...received.values()].filter((t) => t >= sentAt)) - sentAt);
  await sleep(100);
}
await redis.quit();
latencies.sort((a, b) => a - b);
const p95 = latencies[Math.ceil(latencies.length * 0.95) - 1];
check(
  p95 <= 2000,
  `координата доходит до канала заказа: медиана ${latencies[4]} мс, максимум ${p95} мс (PERF-3 ≤ 2 с)`,
);

const own = await call(delivery, `/orders/${orderId}/courier-position`, "GET", null, clientToken);
check(own.status === 200 && own.body.position?.latitude, "клиент заказа видит позицию курьера");
const stranger = await call(
  delivery,
  `/orders/${orderId}/courier-position`,
  "GET",
  null,
  token(randomUUID(), ["client"]),
);
check(stranger.status === 404, "чужой клиент — «не найдено» (SEC-7)");

/* ─────────── 5. Забрал и доставил ─────────── */
console.log("5. Забрал и вручил — заказ доходит до DELIVERED (DLV-5)");
await call(order, `/orders/${orderId}/ready`, "POST", {}, kitchen);
const deliveryId = accepted.body.id;
await call(delivery, `/deliveries/${deliveryId}/picked-up`, "POST", {}, far.token);
await waitUntil(
  async () =>
    (await call(order, `/orders/${orderId}`, "GET", null, clientToken)).body?.status ===
    "IN_TRANSIT",
  15_000,
  "заказ в пути",
);
check(true, "событие «забрал» перевело заказ в «в пути»");
const early = await call(delivery, `/couriers/me/shift`, "POST", { onShift: false }, far.token);
check(early.status === 422, "с заказом на руках со смены не уйти");
await call(delivery, `/deliveries/${deliveryId}/delivered`, "POST", {}, far.token);
await waitUntil(
  async () =>
    (await call(order, `/orders/${orderId}`, "GET", null, clientToken)).body?.status ===
    "DELIVERED",
  15_000,
  "заказ доставлен",
);
check(true, "событие «вручил» завершило заказ");
const freed = (await call(delivery, "/couriers/me", "GET", null, far.token)).body;
check(freed.courier.status === "available" && !freed.delivery, "курьер снова свободен");

/* ─────────── 6. Отмена оператором освобождает курьера ─────────── */
console.log("6. Отмена заказа оператором освобождает курьера");
// Курьеры снова у ресторана: позиция свежая
await call(delivery, "/couriers/me/location", "POST", near.at, near.token);
await call(delivery, "/couriers/me/location", "POST", far.at, far.token);
await sleep(1500);
const second = await placeAndConfirm();
const offered = await waitUntil(
  async () => {
    for (const c of [near, far]) {
      const me = (await call(delivery, "/couriers/me", "GET", null, c.token)).body;
      if (me?.offer) return { courier: c, offer: me.offer };
    }
    return null;
  },
  15_000,
  "предложение по второму заказу",
);
await call(delivery, `/offers/${offered.offer.id}/accept`, "POST", {}, offered.courier.token);
await call(
  order,
  `/operator/orders/${second.orderId}/cancel`,
  "POST",
  { reason: "проверка компенсации" },
  operatorToken,
);
const released = await waitUntil(
  async () => {
    const me = (await call(delivery, "/couriers/me", "GET", null, offered.courier.token)).body;
    return me?.courier.status === "available" && !me.delivery ? me : null;
  },
  20_000,
  "освобождение курьера",
);
check(!!released, "оператор отменил заказ — сага освободила курьера");
const {
  rows: [cancelled],
} = await deliveryDb.query(`SELECT status FROM deliveries WHERE order_id = $1`, [second.orderId]);
check(cancelled?.status === "CANCELLED", "доставка отменённого заказа закрыта");

for (const c of [near, far]) {
  await call(delivery, "/couriers/me/shift", "POST", { onShift: false }, c.token);
}
await deliveryDb.end();
console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nНе пройдено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
