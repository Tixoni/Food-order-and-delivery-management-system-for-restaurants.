/**
 * Замер PERF-3: координата курьера доходит до клиента не дольше чем за 2 с.
 *
 * Путь целиком, как в жизни: курьер отправляет координату мутацией шлюза →
 * шлюз → delivery (позиция в Redis и публикация в канал ws:order:{id}) →
 * подписчик Redis в шлюзе → WebSocket → клиент. Клиент — тот же graphql-ws,
 * что в браузере; в замер не входит только отрисовка точки на карте.
 * Время отправки и получения берётся в одном процессе — расхождение часов
 * между машинами на результат не влияет.
 *
 * CLIENTS — сколько клиентских соединений подписано на заказ одновременно:
 * все получают каждую координату, задержка считается по самому медленному.
 *
 * Только localhost и фиктивные токены: шлюз и delivery запущены с
 * AUTH_DISABLED=true (токен разбирается, подпись не проверяется).
 *
 * Запуск: GATEWAY_URL=http://localhost:13000 DELIVERY_URL=http://localhost:13104 \
 *         SAMPLES=200 CLIENTS=1 node infra/verification/perf3-latency.mjs
 */
import { randomUUID } from "node:crypto";
import { createClient } from "graphql-ws";

const gateway = new URL(process.env.GATEWAY_URL ?? "http://localhost:13000");
const delivery = new URL(process.env.DELIVERY_URL ?? "http://localhost:13104");
for (const url of [gateway, delivery]) {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("проверка с фиктивными токенами допускается только на localhost");
  }
}
const SAMPLES = Number(process.env.SAMPLES ?? 200);
const CLIENTS = Number(process.env.CLIENTS ?? 1);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 100);
const LIMIT_MS = 2000;
const internalToken = process.env.DELIVERY_INTERNAL_TOKEN ?? "delivery-internal-dev-token";

const token = (sub, roles) =>
  `e30.${Buffer.from(JSON.stringify({ sub, realm_access: { roles } })).toString("base64url")}.x`;
const courierUser = randomUUID();
const customerId = randomUUID();
const courierToken = token(courierUser, ["courier"]);
const clientToken = token(customerId, ["client"]);

async function rest(path, method, body, headers) {
  const response = await fetch(new URL(path, delivery), {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return response.json();
}

async function gql(accessToken, query, variables) {
  const response = await fetch(new URL("/graphql", gateway), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(JSON.stringify(body.errors));
  return body.data;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const percentile = (sorted, p) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)];

/* ─────────── Подготовка: курьер везёт заказ клиента ─────────── */
const pickup = { latitude: 55.7503, longitude: 37.6001 };
await rest(
  "/couriers",
  "POST",
  { fullName: "Курьер замера PERF-3", vehicleType: "bike", userId: courierUser },
  { authorization: `Bearer ${token(randomUUID(), ["admin"])}` },
);
await gql(courierToken, `mutation { setCourierShift(onShift: true) { status } }`);
const location = (latitude, longitude) =>
  gql(
    courierToken,
    `mutation($latitude: Float!, $longitude: Float!) {
       updateCourierLocation(latitude: $latitude, longitude: $longitude)
     }`,
    { latitude, longitude },
  );
await location(pickup.latitude + 0.001, pickup.longitude);
await sleep(1500); // позиция для подбора пишется в базу пачкой

const orderId = randomUUID();
await rest(
  "/deliveries",
  "POST",
  {
    orderId,
    restaurantId: randomUUID(),
    customerId,
    idempotencyKey: `${orderId}:courier:1`,
    pickup,
    dropoff: { latitude: pickup.latitude + 0.02, longitude: pickup.longitude + 0.02 },
    readyAt: new Date().toISOString(),
  },
  { "x-internal-token": internalToken },
);
let offerId = null;
for (let i = 0; i < 20 && !offerId; i += 1) {
  const { courierDashboard } = await gql(
    courierToken,
    `query { courierDashboard { offer { id } } }`,
  );
  offerId = courierDashboard.offer?.id;
  if (!offerId) await sleep(250);
}
if (!offerId)
  throw new Error("курьер не получил предложение — рядом есть другие свободные курьеры?");
await gql(courierToken, `mutation($id: ID!) { acceptOffer(id: $id) { status } }`, { id: offerId });

/* ─────────── Клиенты подписываются на позицию ─────────── */
const pending = new Map(); // широта → { sent, left }
const latencies = [];
const wsUrl = new URL("/graphql", gateway);
wsUrl.protocol = "ws:";
const clients = [];
const ready = new Set(); // соединения, получившие прогревочную координату
for (let i = 0; i < CLIENTS; i += 1) {
  const client = createClient({
    url: wsUrl.href,
    connectionParams: { authorization: `Bearer ${clientToken}` },
  });
  clients.push(client);
  client.subscribe(
    {
      query: `subscription($orderId: ID!) {
        courierPositionUpdated(orderId: $orderId) { latitude longitude at }
      }`,
      variables: { orderId },
    },
    {
      next: ({ data }) => {
        const received = performance.now();
        const key = data.courierPositionUpdated.latitude.toFixed(7);
        const entry = pending.get(key);
        if (!entry) {
          ready.add(i); // прогревочная координата
          return;
        }
        entry.left -= 1;
        if (entry.left === 0) {
          latencies.push(received - entry.sent);
          pending.delete(key);
        }
      },
      error: (error) => console.error("подписка:", error),
      complete: () => undefined,
    },
  );
}

// Подписка не подтверждается отдельным сообщением: шлём прогревочные
// координаты, пока их не получат все соединения.
for (let i = 0; i < 50 && ready.size < CLIENTS; i += 1) {
  await location(pickup.latitude + 0.0005, pickup.longitude + i * 0.000001);
  await sleep(200);
}
if (ready.size < CLIENTS) {
  throw new Error(`подписались ${ready.size} из ${CLIENTS} соединений`);
}

/* ─────────── Замер ─────────── */
console.log(
  `PERF-3: ${SAMPLES} координат, каждые ${INTERVAL_MS} мс, подписанных соединений: ${CLIENTS}`,
);
const lost = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const latitude = pickup.latitude + 0.002 + i * 0.00001;
  const key = latitude.toFixed(7);
  pending.set(key, { sent: performance.now(), left: CLIENTS });
  await location(latitude, pickup.longitude);
  await sleep(INTERVAL_MS);
}
await sleep(LIMIT_MS);
for (const key of pending.keys()) lost.push(key);

const sorted = [...latencies].sort((a, b) => a - b);
const fmt = (ms) => `${ms.toFixed(1)} мс`;
console.log(
  `  получено ${sorted.length} из ${SAMPLES}` +
    `\n  медиана ${fmt(percentile(sorted, 0.5))}, p95 ${fmt(percentile(sorted, 0.95))},` +
    ` p99 ${fmt(percentile(sorted, 0.99))}, максимум ${fmt(sorted.at(-1))}`,
);

/* ─────────── Уборка ─────────── */
for (const client of clients) await client.dispose();
await rest("/deliveries/release", "POST", { orderId }, { "x-internal-token": internalToken });
await gql(courierToken, `mutation { setCourierShift(onShift: false) { status } }`).catch(
  () => null,
);

const ok = lost.length === 0 && sorted.at(-1) <= LIMIT_MS;
console.log(
  ok
    ? `\n✓ PERF-3 выполнено: все координаты дошли, самая долгая — ${fmt(sorted.at(-1))} при пределе ${LIMIT_MS} мс`
    : `\n✗ PERF-3 не выполнено: потеряно ${lost.length}, максимум ${fmt(sorted.at(-1) ?? NaN)}`,
);
process.exit(ok ? 0 : 1);
