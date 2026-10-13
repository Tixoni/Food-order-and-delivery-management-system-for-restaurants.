/**
 * Проверка маршрутизатора на живых процессах: delivery + PostgreSQL/PostGIS
 * + Redis + Kafka + OSRM с картой Москвы. Только localhost и фиктивные
 * токены (delivery запущен с AUTH_DISABLED=true).
 *
 * Сценарий:
 *   1. по самому OSRM ищется место, где ближний по прямой курьер дольше
 *      едет по дорогам (река, железная дорога, промзона без проездов);
 *   2. заказ получает тот, кто раньше доедет, а не ближний по прямой (DLV-3, DLV-6);
 *   3. маршрут «ресторан → клиент» — на экране курьера и у клиента, длина
 *      совпадает с OSRM; прогноз в событии «забрал» — по длине маршрута;
 *   4. OSRM остановлен (REL-2): подбор продолжается по прямой и отвечает
 *      быстро, сохранённый маршрут виден, новый не появляется;
 *   5. OSRM снова работает — маршрут второго заказа появляется без
 *      перезапуска delivery (размыкатель цепи закрывается сам).
 *
 * Запуск (карта: npm run osrm:prepare; delivery с OSRM_URL на тот же OSRM):
 *   DELIVERY_URL=http://localhost:13104 OSRM_URL=http://localhost:15000 \
 *   OSRM_CONTAINER=fd-osrm POSTGRES_PORT=15432 node infra/verification/routing-e2e.mjs
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import pg from "pg";

const delivery = new URL(process.env.DELIVERY_URL ?? "http://localhost:13104");
const osrm = new URL(process.env.OSRM_URL ?? "http://localhost:15000");
const container = process.env.OSRM_CONTAINER ?? "fd-osrm";
const internalToken = process.env.DELIVERY_INTERNAL_TOKEN ?? "delivery-internal-dev-token";
for (const url of [delivery, osrm]) {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("проверка с фиктивными токенами допускается только на localhost");
  }
}

const token = (sub, roles) =>
  `e30.${Buffer.from(JSON.stringify({ sub, realm_access: { roles } })).toString("base64url")}.x`;
const adminToken = token(randomUUID(), ["admin"]);
const customerId = randomUUID();
const clientToken = token(customerId, ["client"]);

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}

async function call(path, method = "GET", body, headers = {}) {
  const response = await fetch(new URL(path, delivery), {
    method,
    headers: { ...(body ? { "content-type": "application/json" } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
}
const as = (accessToken) => ({ authorization: `Bearer ${accessToken}` });

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitUntil(probe, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await probe().catch(() => null);
    if (value) return value;
    await sleep(500);
  }
  throw new Error(`не дождались: ${message}`);
}

const coordinate = (p) => `${p.longitude.toFixed(6)},${p.latitude.toFixed(6)}`;
async function osrmJson(path) {
  const response = await fetch(new URL(path, osrm), { signal: AbortSignal.timeout(3000) });
  return response.json();
}

/** Точка в `meters` от `from` по азимуту `bearing` (градусы). */
function offset(from, meters, bearing) {
  const rad = (bearing * Math.PI) / 180;
  return {
    latitude: from.latitude + (meters * Math.cos(rad)) / 111_195,
    longitude:
      from.longitude +
      (meters * Math.sin(rad)) / (111_195 * Math.cos((from.latitude * Math.PI) / 180)),
  };
}

function straight(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 2 * 6_371_000 * Math.asin(Math.sqrt(h));
}

/* ─────────── 1. Место, где прямая обманывает ─────────── */
console.log("1. Ищем по карте место, где ближний по прямой едет дольше (OSRM)");
// У Москвы-реки и путей: Парк Горького, Лужники, Нагатино, Сити, Курский вокзал
const spots = [
  { latitude: 55.7298, longitude: 37.6011 },
  { latitude: 55.7158, longitude: 37.5537 },
  { latitude: 55.6826, longitude: 37.6745 },
  { latitude: 55.7496, longitude: 37.5376 },
  { latitude: 55.7586, longitude: 37.6612 },
];
let plan = null;
for (const pickup of spots) {
  const samples = [];
  for (const meters of [500, 900, 1300, 1700]) {
    for (let bearing = 0; bearing < 360; bearing += 30)
      samples.push(offset(pickup, meters, bearing));
  }
  const table = await osrmJson(
    `/table/v1/driving/${[pickup, ...samples].map(coordinate).join(";")}` +
      `?sources=${samples.map((_, i) => i + 1).join(";")}&destinations=0&annotations=distance`,
  );
  const measured = samples
    .map((point, i) => ({
      point,
      straight: straight(point, pickup),
      road: table.distances?.[i]?.[0],
    }))
    .filter((s) => typeof s.road === "number" && s.road > 0);
  // A — ближе по прямой, B — дальше по прямой, но по дорогам короче с запасом
  let best = null;
  for (const a of measured) {
    for (const b of measured) {
      if (a.straight + 300 < b.straight && a.road > b.road * 1.4) {
        const gain = a.road - b.road;
        if (!best || gain > best.gain) best = { a, b, gain };
      }
    }
  }
  if (best) {
    const c = measured.find(
      (s) => s.straight > best.a.straight + 200 && s !== best.b && s.straight < 2500,
    );
    if (c) {
      plan = { pickup, ...best, c };
      break;
    }
  }
}
if (!plan) throw new Error("не нашли подходящего места — проверьте карту OSRM");
const { pickup, a, b, c } = plan;
console.log(
  `  ресторан ${coordinate(pickup)}: A — ${Math.round(a.straight)} м по прямой / ${Math.round(a.road)} м по дорогам;` +
    ` B — ${Math.round(b.straight)} / ${Math.round(b.road)} м`,
);
check(a.straight < b.straight && a.road > b.road, "A ближе по прямой, B ближе по дорогам");

const db = new pg.Client({
  host: "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: "app",
  password: "app",
  database: "delivery_db",
});
await db.connect();
// Курьеры прошлых прогонов не должны оказаться ближе нынешних.
await db.query(`UPDATE couriers SET status = 'offline' WHERE status = 'available'`);

async function courier(name, at) {
  const userId = randomUUID();
  const created = await call(
    "/couriers",
    "POST",
    { fullName: name, vehicleType: "bike", userId },
    as(adminToken),
  );
  const own = token(userId, ["courier"]);
  await call("/couriers/me/shift", "POST", { onShift: true }, as(own));
  await call("/couriers/me/location", "POST", at, as(own));
  return { id: created.body.id, token: own };
}
const courierA = await courier("A: ближе по прямой (проверка)", a.point);
const courierB = await courier("B: ближе по дорогам (проверка)", b.point);
const courierC = await courier("C: запасной (проверка)", c.point);
await sleep(1500); // пакетная запись обновляет позицию для подбора

const dropoff = offset(pickup, 2500, 45);
async function requestCourier(orderId) {
  const started = performance.now();
  const response = await call(
    "/deliveries",
    "POST",
    {
      orderId,
      restaurantId: randomUUID(),
      customerId,
      idempotencyKey: `${orderId}:courier:1`,
      pickup,
      dropoff,
      readyAt: new Date().toISOString(),
      orderNumber: 1,
      dropoffAddress: "проверка маршрутизатора",
    },
    { "x-internal-token": internalToken },
  );
  return { ...response, ms: performance.now() - started };
}
const offerOf = async (who) => (await call("/couriers/me", "GET", null, as(who.token))).body?.offer;

/* ─────────── 2. Подбор по времени в пути ─────────── */
console.log("\n2. Заказ получает тот, кто раньше доедет по дорогам (DLV-3, DLV-6)");
const order1 = randomUUID();
const first = await requestCourier(order1);
check(first.status === 200 || first.status === 201, "доставка создана", first.body);
const offerB = await waitUntil(() => offerOf(courierB), 5000, "предложение курьеру B");
check(!!offerB, "предложение ушло B — ближнему по дорогам");
check(!(await offerOf(courierA)), "A, ближнему по прямой, не предложено");

/* ─────────── 3. Маршрут на экранах ─────────── */
console.log("\n3. Маршрут «ресторан → клиент» у курьера и у клиента");
const direct = await osrmJson(
  `/route/v1/driving/${coordinate(pickup)};${coordinate(dropoff)}?overview=false`,
);
const route = offerB.delivery.route;
check(
  route && Math.abs(route.distanceMeters - direct.routes[0].distance) <= 1,
  "длина маршрута — как у OSRM",
  {
    ours: route?.distanceMeters,
    osrm: direct.routes[0].distance,
  },
);
check(route?.path?.length > 2, `линия маршрута для карты: ${route?.path?.length} точек`);
console.log(
  `  по прямой ${Math.round(straight(pickup, dropoff))} м, по дорогам ${route?.distanceMeters} м`,
);
const accepted = await call(`/offers/${offerB.id}/accept`, "POST", {}, as(courierB.token));
check(accepted.status === 200 || accepted.status === 201, "B принял заказ");
const tracked = await call(`/orders/${order1}/courier-position`, "GET", null, as(clientToken));
check(tracked.body?.route?.distanceMeters === route?.distanceMeters, "клиент видит тот же маршрут");

await call(`/deliveries/${first.body.deliveryId}/picked-up`, "POST", {}, as(courierB.token));
const {
  rows: [picked],
} = await db.query(
  `SELECT payload->'payload'->>'etaMinutes' AS eta FROM outbox_messages
    WHERE event_type = 'OrderPickedUp' AND headers->>'partitionKey' = $1`,
  [order1],
);
const expectedEta = Math.max(1, Math.ceil((route.distanceMeters / 1000 / 14) * 60));
check(Number(picked?.eta) === expectedEta, `прогноз «забрал» по маршруту: ${picked?.eta} мин`, {
  expected: expectedEta,
});

/* ─────────── 4. Без маршрутизатора ─────────── */
console.log("\n4. OSRM остановлен — подбор и экраны работают (REL-2)");
execFileSync("docker", ["stop", container], { stdio: "ignore" });
const order2 = randomUUID();
const second = await requestCourier(order2);
check(
  second.status === 200 || second.status === 201,
  `доставка создана за ${Math.round(second.ms)} мс`,
);
const offerA = await waitUntil(() => offerOf(courierA), 5000, "предложение курьеру A");
check(!!offerA, "предложение ушло A — ближнему по прямой");
check(offerA?.delivery?.route === null, "у нового заказа маршрута нет — карта нарисует прямую");
const timings = [];
for (let i = 0; i < 5; i += 1) {
  const started = performance.now();
  await call(`/orders/${order2}/courier-position`, "GET", null, as(clientToken));
  timings.push(performance.now() - started);
}
check(
  Math.max(...timings.slice(-2)) < 100,
  `цепь разомкнута — экран клиента отвечает без ожидания: ${timings.map(Math.round).join(", ")} мс`,
);
const keptRoute = (await call("/couriers/me", "GET", null, as(courierB.token))).body?.delivery
  ?.route;
check(
  keptRoute?.distanceMeters === route.distanceMeters,
  "сохранённый маршрут первого заказа виден",
);

/* ─────────── 5. Маршрутизатор вернулся ─────────── */
console.log("\n5. OSRM снова работает — маршрут появляется без перезапуска delivery");
execFileSync("docker", ["start", container], { stdio: "ignore" });
await waitUntil(
  async () =>
    (await osrmJson(`/route/v1/driving/${coordinate(pickup)};${coordinate(dropoff)}`)).code ===
    "Ok",
  30_000,
  "OSRM после запуска",
);
const healed = await waitUntil(
  async () =>
    (await call(`/orders/${order2}/courier-position`, "GET", null, as(clientToken))).body?.route,
  40_000,
  "маршрут второго заказа",
);
check(
  healed?.distanceMeters === route.distanceMeters,
  "маршрут второго заказа посчитан и сохранён",
);

/* ─────────── Уборка ─────────── */
for (const orderId of [order1, order2]) {
  await call("/deliveries/release", "POST", { orderId }, { "x-internal-token": internalToken });
}
await db.query(`UPDATE couriers SET status = 'offline' WHERE id = ANY($1)`, [
  [courierA.id, courierB.id, courierC.id],
]);
await db.end();

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
