/**
 * Замер PERF-4: новый заказ появляется на экране кухни не позже 3 с
 * с момента оплаты.
 *
 * Кухня ведёт себя как экран /kitchen: подписка kitchenQueueChanged по
 * WebSocket, на каждый сигнал — запрос очереди. Заказ «появился», когда он
 * есть в ответе очереди. Клиент оформляет заказ через шлюз, оплата идёт
 * через payment и эмулятор провайдера — путь тот же, что в браузере.
 *
 * Два отсчёта:
 *   от оплаты     — от перехода заказа в PAID (время из истории заказа;
 *                   сервисы и замер на одной машине, часы общие);
 *   от оформления — от нажатия «Оформить», включая саму оплату (строже).
 *
 * Только localhost и фиктивные токены: шлюз, order, catalog, payment
 * запущены с AUTH_DISABLED=true. Ресторан — первый, который сейчас
 * принимает заказы (или RESTAURANT_ID). Заказы после замера кухня
 * отклоняет — холд снимается.
 *
 * Запуск: GATEWAY_URL=http://localhost:13000 CATALOG_URL=http://localhost:13101 \
 *         SAMPLES=20 node infra/verification/perf4-kitchen.mjs
 */
import { randomUUID } from "node:crypto";
import { createClient } from "graphql-ws";

const gateway = new URL(process.env.GATEWAY_URL ?? "http://localhost:13000");
const catalog = new URL(process.env.CATALOG_URL ?? "http://localhost:13101");
for (const url of [gateway, catalog]) {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("проверка с фиктивными токенами допускается только на localhost");
  }
}
const SAMPLES = Number(process.env.SAMPLES ?? 20);
const LIMIT_MS = 3000;

const token = (sub, roles, restaurantId) =>
  `e30.${Buffer.from(JSON.stringify({ sub, realm_access: { roles }, restaurantId })).toString("base64url")}.x`;

const getJson = async (path) => (await fetch(new URL(path, catalog))).json();
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

/* ─────────── Ресторан, который сейчас принимает заказы ─────────── */
async function pickRestaurant() {
  const points = [
    [55.7558, 37.6176],
    [55.7601, 37.6101],
    [55.7522, 37.5927],
    [55.7299, 37.6034],
  ];
  for (const [lat, lon] of points) {
    const offers = await getJson(`/restaurants/delivery-to?lat=${lat}&lon=${lon}&limit=50`);
    for (const offer of offers.items ?? []) {
      if (process.env.RESTAURANT_ID && offer.id !== process.env.RESTAURANT_ID) continue;
      const open = await getJson(`/restaurants/${offer.id}/orderability`);
      if (!open.isOpen) continue;
      const menu = await getJson(`/restaurants/${offer.id}/menu`);
      const item = (menu.categories ?? [])
        .flatMap((category) => category.items ?? [])
        .find((i) => i.isAvailable !== false && (i.optionGroups ?? []).every((g) => !g.isRequired));
      if (!item) continue;
      return {
        restaurantId: offer.id,
        name: offer.name,
        item: {
          itemId: item.id,
          quantity: Math.max(1, Math.ceil(offer.minOrderAmount / item.price)),
        },
        address: { latitude: lat, longitude: lon, text: "Замер PERF-4, д. 1" },
      };
    }
  }
  throw new Error(
    "сейчас ни один ресторан не принимает заказы (часы работы) — задайте RESTAURANT_ID",
  );
}

const target = await pickRestaurant();
console.log(`PERF-4: ${SAMPLES} заказов в «${target.name}»`);
const clientToken = token(randomUUID(), ["client"]);
const kitchenToken = token(randomUUID(), ["kitchen"], target.restaurantId);

/* ─────────── Кухня: подписка + перечитывание очереди ─────────── */
const waiting = new Map(); // orderId → resolve(момент появления)
const appearedAt = new Map(); // orderId → когда кухня впервые увидела заказ
const seen = new Set();
async function readQueue() {
  const { kitchenQueue } = await gql(kitchenToken, `query { kitchenQueue { id status } }`);
  const now = performance.now();
  for (const order of kitchenQueue) {
    if (seen.has(order.id)) continue;
    seen.add(order.id);
    appearedAt.set(order.id, now);
    waiting.get(order.id)?.(now);
  }
}
let subscribed = false;
const wsUrl = new URL("/graphql", gateway);
wsUrl.protocol = "ws:";
const kitchen = createClient({
  url: wsUrl.href,
  connectionParams: { authorization: `Bearer ${kitchenToken}` },
  on: { connected: () => (subscribed = true) },
});
kitchen.subscribe(
  { query: `subscription { kitchenQueueChanged { orderId status } }` },
  {
    next: () => void readQueue(),
    error: (error) => console.error("подписка кухни:", error),
    complete: () => undefined,
  },
);
for (let i = 0; i < 40 && !subscribed; i += 1) await sleep(100);
await sleep(500);
await readQueue(); // то, что было в очереди до замера, не считается

/* ─────────── Замер ─────────── */
const fromPayment = [];
const fromCheckout = [];
const placed = [];
for (let i = 0; i < SAMPLES; i += 1) {
  const sent = performance.now();
  const sentWall = Date.now();
  const { placeOrder } = await gql(
    clientToken,
    `mutation($input: PlaceOrderInput!) { placeOrder(input: $input) { order { id } } }`,
    {
      input: {
        restaurantId: target.restaurantId,
        idempotencyKey: randomUUID(),
        contactPhone: "+7 900 000-00-00",
        address: target.address,
        items: [target.item],
      },
    },
  );
  const orderId = placeOrder.order.id;
  placed.push(orderId);
  // Заказ мог появиться у кухни раньше, чем оформление вернуло ответ.
  const appeared = appearedAt.has(orderId)
    ? Promise.resolve(appearedAt.get(orderId))
    : new Promise((resolve) => {
        waiting.set(orderId, resolve);
        setTimeout(() => resolve(null), 10_000);
      });
  const at = await appeared;
  if (at === null) {
    console.log(`  заказ ${orderId}: на экране кухни не появился за 10 с`);
    continue;
  }
  const appearedWall = sentWall + (at - sent);
  const { orderTransitions } = await gql(
    clientToken,
    `query($id: ID!) { orderTransitions(id: $id) { to at } }`,
    { id: orderId },
  );
  const paid = orderTransitions.find((t) => t.to === "PAID");
  fromCheckout.push(at - sent);
  if (paid) fromPayment.push(appearedWall - new Date(paid.at).getTime());
  await sleep(200);
}

/* ─────────── Итоги ─────────── */
const fmt = (ms) => `${Math.round(ms)} мс`;
function report(title, values) {
  const sorted = [...values].sort((a, b) => a - b);
  console.log(
    `  ${title}: медиана ${fmt(percentile(sorted, 0.5))}, p95 ${fmt(percentile(sorted, 0.95))},` +
      ` максимум ${fmt(sorted.at(-1))}`,
  );
  return sorted.at(-1);
}
console.log(`  появились на экране: ${fromCheckout.length} из ${SAMPLES}`);
const worstPaid = report("от оплаты", fromPayment);
report("от оформления, включая оплату", fromCheckout);

/* ─────────── Уборка: кухня отклоняет, холд снимается ─────────── */
for (const id of placed) {
  await gql(
    kitchenToken,
    `mutation($id: ID!) { rejectOrder(id: $id, reason: "замер PERF-4") { status } }`,
    { id },
  ).catch(() => null);
}
await kitchen.dispose();

const ok =
  fromCheckout.length === SAMPLES && fromPayment.length === SAMPLES && worstPaid <= LIMIT_MS;
console.log(
  ok
    ? `\n✓ PERF-4 выполнено: самый долгий заказ появился через ${fmt(worstPaid)} после оплаты при пределе ${LIMIT_MS} мс`
    : `\n✗ PERF-4 не выполнено`,
);
process.exit(ok ? 0 : 1);
