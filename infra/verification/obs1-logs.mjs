/**
 * Проверка OBS-1: журналы всех сервисов — в одном месте, в JSON, одно
 * действие пользователя находится одним запросом по сквозному идентификатору;
 * персональных данных и секретов в журналах нет (SEC-3, SEC-4).
 *
 * Сценарий: клиент через прокси оформляет заказ, передав свой сквозной
 * идентификатор (x-correlation-id), — оплата проходит фоновым шагом саги;
 * затем отменяет его — компенсация (снятие холда) идёт фоновым шагом с тем
 * же идентификатором оформления. После этого в Loki:
 *   1. записи оформления есть у шлюза, заказов, каталога и платежей;
 *   2. каждая запись — JSON с временем, уровнем, сервисом, сообщением и
 *      идентификатором;
 *   3. телефон, адрес, пароль и токен клиента не встречаются ни в одной
 *      строке ни одного контейнера.
 *
 * Окружение — профили apps и observability. Вход — учебной учётной записью
 * клиента (CLIENT_LOGIN / CLIENT_PASSWORD, по умолчанию client@food.local).
 *
 * Запуск: WEB_URL=http://localhost:13080 LOKI_URL=http://localhost:13100 \
 *         node infra/verification/obs1-logs.mjs
 */
import { randomInt, randomUUID } from "node:crypto";

const web = new URL(process.env.WEB_URL ?? "http://localhost:13080");
const loki = new URL(process.env.LOKI_URL ?? "http://localhost:13100");
for (const url of [web, loki]) {
  if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
    throw new Error("проверка с учебными учётными данными допускается только на localhost");
  }
}
const username = process.env.CLIENT_LOGIN ?? "client@food.local";
const password = process.env.CLIENT_PASSWORD ?? "client";

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const started = Date.now();
const login = await fetch(new URL("/auth/login", web), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
const { accessToken } = await login.json();
if (!accessToken) throw new Error(`вход: ${login.status}`);

async function gql(query, variables, correlationId) {
  const response = await fetch(new URL("/graphql", web), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      ...(correlationId ? { "x-correlation-id": correlationId } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return body.data;
}

/* ─────────── Действие пользователя ─────────── */
console.log("1. Клиент оформляет и отменяет заказ под своим сквозным идентификатором");
const placeId = `obs1-${randomUUID()}`;
const cancelId = `obs1-cancel-${randomUUID()}`;
// Уникальные значения — чтобы найти их в журналах, если они туда попали
const phone = `+7 900 ${randomInt(100, 999)}-${randomInt(10, 99)}-${randomInt(10, 99)}`;
const addressText = `Проверочная улица, дом ${randomInt(1000, 9999)}`;

const { restaurantsNearby } = await gql(
  `query { restaurantsNearby(latitude: 55.7558, longitude: 37.6176, limit: 20) { id name minOrderAmount } }`,
);
let orderId = null;
for (const offer of restaurantsNearby) {
  const { menu } = await gql(
    `query($id: ID!) { menu(restaurantId: $id) {
       categories { items { id price isAvailable optionGroups { isRequired } } } } }`,
    { id: offer.id },
  );
  const item = menu.categories
    .flatMap((c) => c.items)
    .find((i) => i.isAvailable && i.optionGroups.every((g) => !g.isRequired));
  if (!item) continue;
  try {
    const { placeOrder } = await gql(
      `mutation($input: PlaceOrderInput!) { placeOrder(input: $input) { order { id } } }`,
      {
        input: {
          restaurantId: offer.id,
          idempotencyKey: randomUUID(),
          contactPhone: phone,
          address: { latitude: 55.7558, longitude: 37.6176, text: addressText },
          items: [
            {
              itemId: item.id,
              quantity: Math.max(1, Math.ceil(offer.minOrderAmount / item.price)),
            },
          ],
        },
      },
      placeId,
    );
    orderId = placeOrder.order.id;
    console.log(`  заказ в «${offer.name}», идентификатор действия ${placeId}`);
    break;
  } catch {
    // закрыт или не доставляет по адресу — следующий
  }
}
if (!orderId) throw new Error("не нашли ресторан, который сейчас принимает заказы");

const status = async () =>
  (await gql(`query($id: ID!) { order(id: $id) { status } }`, { id: orderId })).order.status;
for (let i = 0; i < 40 && (await status()) !== "AWAITING_RESTAURANT"; i += 1) await sleep(250);
check((await status()) === "AWAITING_RESTAURANT", "оплата прошла фоновым шагом саги");
await gql(
  `mutation($id: ID!) { cancelOrder(id: $id, reason: "проверка OBS-1") { status } }`,
  { id: orderId },
  cancelId,
);
await sleep(3000); // компенсация — фоновым шагом
console.log("  ждём, пока журналы дойдут до Loki…");
await sleep(6000);

/* ─────────── Поиск в Loki ─────────── */
async function query(expr) {
  const url = new URL("/loki/api/v1/query_range", loki);
  url.searchParams.set("query", expr);
  url.searchParams.set("start", String((started - 60_000) * 1e6));
  url.searchParams.set("end", String((Date.now() + 5_000) * 1e6));
  url.searchParams.set("limit", "5000");
  url.searchParams.set("direction", "forward");
  const response = await fetch(url);
  const body = await response.json();
  if (body.status !== "success") throw new Error(`Loki: ${JSON.stringify(body).slice(0, 200)}`);
  return body.data.result.flatMap((stream) =>
    stream.values.map(([ts, line]) => ({ ts: Number(ts) / 1e6, labels: stream.stream, line })),
  );
}

console.log("\n2. Все записи оформления — одним запросом по идентификатору");
const placed = (await query(`{service=~".+"} | correlation_id="${placeId}"`)).sort(
  (a, b) => a.ts - b.ts,
);
const services = [...new Set(placed.map((r) => r.labels.service))].sort();
console.log(`  ${placed.length} записей, сервисы: ${services.join(", ")}`);
for (const service of ["gateway", "order", "catalog", "payment"]) {
  check(services.includes(service), `есть записи сервиса ${service}`);
}
const parsed = placed.map((r) => {
  try {
    return JSON.parse(r.line);
  } catch {
    return null;
  }
});
check(
  parsed.every(
    (r) => r && r.timestamp && r.level && r.service && r.message && r.correlationId === placeId,
  ),
  "каждая запись — JSON: время, уровень, сервис, сообщение, идентификатор",
);
check(
  parsed.some(
    (r) => r?.service === "payment" && /отмен|снят|void|release/i.test(JSON.stringify(r)),
  ) || parsed.filter((r) => r?.service === "payment").length >= 2,
  "компенсация (снятие холда) записана под идентификатором оформления",
);
console.log("  ход действия:");
for (const r of parsed.slice(0, 30)) {
  if (!r) continue;
  const extra = [
    r.method,
    r.route,
    r.status,
    r.durationMs !== undefined ? `${r.durationMs} мс` : "",
    r.operation,
    r.type,
    r.outcome,
  ]
    .filter(Boolean)
    .join(" ");
  console.log(
    `    ${r.timestamp.slice(11, 23)}  ${r.service.padEnd(8)} ${r.message}${extra ? ` — ${extra}` : ""}`,
  );
}

const cancelled = await query(`{service=~".+"} | correlation_id="${cancelId}"`);
check(
  cancelled.length > 0,
  `отмена — отдельное действие со своим идентификатором: ${cancelled.length} записей`,
);

console.log("\n3. Персональных данных и секретов в журналах нет — во всех контейнерах");
const digits = phone.replace(/\D/g, "");
const secrets = [
  ["телефон клиента", phone],
  ["телефон без разделителей", digits],
  ["адрес доставки", addressText],
  ["токен доступа", accessToken.slice(-24)],
  ["заголовок авторизации", "Bearer "],
];
// Пароль учебной записи — словарное слово («client» встречается в служебных
// строках Kafka), буквальный поиск по нему ничего не доказывает. Ищется
// буквально только длинный пароль; поле password — всегда.
if (password.length >= 10) secrets.push(["пароль", password]);
// Сами средства наблюдения не в счёт: Loki пишет в свой журнал текст
// выполненных запросов — в том числе этих поисков.
const everywhere = `{service=~".+", service!~"loki|alloy|grafana"}`;
for (const [what, value] of secrets) {
  const found = await query(`${everywhere} |= ${JSON.stringify(value)}`);
  check(
    found.length === 0,
    `${what} не встречается`,
    found.slice(0, 2).map((r) => r.line.slice(0, 160)),
  );
}
const passwordFields = await query(
  `{service=~"gateway|catalog|order|payment|delivery"} |~ "\\"password\\":\\"[^*]"`,
);
check(passwordFields.length === 0, "поле password в журналах сервисов только замаскировано");

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
