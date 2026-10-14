/**
 * Проверка OBS-2: сквозная трасса через все компоненты, включая
 * асинхронную часть, — в одном интерфейсе (Jaeger).
 *
 * Сценарий: клиент через прокси оформляет заказ (номер трассы — в заголовке
 * ответа x-trace-id), оплата проходит фоновым шагом саги; затем клиент
 * отменяет заказ — снятие холда идёт фоновым шагом. Проверяется:
 *   1. трасса оформления проходит через шлюз, каталог, заказы, платежи и
 *      провайдера — включая фоновый шаг саги и события через брокер;
 *   2. трасса не рвётся: один корень, у каждого участка родитель в той же
 *      трассе (асинхронные шаги — дочерние, а не новые трассы);
 *   3. трасса отмены содержит компенсацию — снятие холда у провайдера;
 *   4. из трассы — к журналам: записи с её номером есть в Loki.
 *
 * Окружение — профили apps и observability. Вход — учебной учётной записью
 * клиента (CLIENT_LOGIN / CLIENT_PASSWORD, по умолчанию client@food.local).
 *
 * Запуск: WEB_URL=http://localhost:13080 JAEGER_URL=http://localhost:13686 \
 *         LOKI_URL=http://localhost:13100 node infra/verification/obs2-trace.mjs
 */
import { randomUUID } from "node:crypto";

const web = new URL(process.env.WEB_URL ?? "http://localhost:13080");
const jaeger = new URL(process.env.JAEGER_URL ?? "http://localhost:13686");
const loki = new URL(process.env.LOKI_URL ?? "http://localhost:13100");
for (const url of [web, jaeger, loki]) {
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

const login = await fetch(new URL("/auth/login", web), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username, password }),
});
const { accessToken } = await login.json();
if (!accessToken) throw new Error(`вход: ${login.status}`);

async function gql(query, variables) {
  const response = await fetch(new URL("/graphql", web), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${accessToken}`,
      // Снаружи свою трассу не навязать: прокси отбрасывает этот заголовок
      traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await response.json();
  if (body.errors) throw new Error(body.errors[0].message);
  return { data: body.data, traceId: response.headers.get("x-trace-id") };
}

/* ─────────── Действие пользователя ─────────── */
console.log("1. Клиент оформляет и отменяет заказ");
const {
  data: { restaurantsNearby },
} = await gql(
  `query { restaurantsNearby(latitude: 55.7558, longitude: 37.6176, limit: 20) { id name minOrderAmount } }`,
);
let orderId = null;
let placeTrace = null;
for (const offer of restaurantsNearby) {
  const {
    data: { menu },
  } = await gql(
    `query($id: ID!) { menu(restaurantId: $id) {
       categories { items { id price isAvailable optionGroups { isRequired } } } } }`,
    { id: offer.id },
  );
  const item = menu.categories
    .flatMap((c) => c.items)
    .find((i) => i.isAvailable && i.optionGroups.every((g) => !g.isRequired));
  if (!item) continue;
  try {
    const placed = await gql(
      `mutation($input: PlaceOrderInput!) { placeOrder(input: $input) { order { id } } }`,
      {
        input: {
          restaurantId: offer.id,
          idempotencyKey: randomUUID(),
          contactPhone: "+7 900 000-00-00",
          address: { latitude: 55.7558, longitude: 37.6176, text: "Проверка OBS-2, д. 1" },
          items: [
            {
              itemId: item.id,
              quantity: Math.max(1, Math.ceil(offer.minOrderAmount / item.price)),
            },
          ],
        },
      },
    );
    orderId = placed.data.placeOrder.order.id;
    placeTrace = placed.traceId;
    console.log(`  заказ в «${offer.name}», трасса оформления ${placeTrace}`);
    break;
  } catch {
    // закрыт или не доставляет по адресу — следующий
  }
}
if (!orderId) throw new Error("не нашли ресторан, который сейчас принимает заказы");
check(/^[0-9a-f]{32}$/.test(placeTrace ?? ""), "номер трассы — в заголовке ответа x-trace-id");
check(
  placeTrace !== "0123456789abcdef0123456789abcdef",
  "трасса началась на шлюзе — заголовок traceparent клиента отброшен прокси",
);

const status = async () =>
  (await gql(`query($id: ID!) { order(id: $id) { status } }`, { id: orderId })).data.order.status;
for (let i = 0; i < 40 && (await status()) !== "AWAITING_RESTAURANT"; i += 1) await sleep(250);
check((await status()) === "AWAITING_RESTAURANT", "оплата прошла фоновым шагом саги");
const cancelled = await gql(
  `mutation($id: ID!) { cancelOrder(id: $id, reason: "проверка OBS-2") { status } }`,
  { id: orderId },
);
const cancelTrace = cancelled.traceId;
console.log(`  трасса отмены ${cancelTrace}`);

/* ─────────── Трассы в Jaeger ─────────── */
async function fetchTrace(traceId) {
  const response = await fetch(new URL(`/api/traces/${traceId}`, jaeger));
  if (!response.ok) return null;
  const body = await response.json();
  const data = body.data?.[0];
  if (!data) return null;
  return data.spans.map((span) => ({
    id: span.spanID,
    parent: span.references?.find((r) => r.refType === "CHILD_OF")?.spanID ?? null,
    name: span.operationName,
    service: data.processes[span.processID].serviceName,
    start: span.startTime,
    durationMs: span.duration / 1000,
  }));
}

/** Участки отправляются пачками раз в несколько секунд — ждём, пока трасса перестанет расти. */
async function settledTrace(traceId, mustHave) {
  let spans = null;
  let previous = -1;
  for (let i = 0; i < 30; i += 1) {
    await sleep(1000);
    spans = await fetchTrace(traceId);
    const count = spans?.length ?? 0;
    if (count > 0 && count === previous && mustHave(spans)) return spans;
    previous = count;
  }
  return spans ?? [];
}

function printTree(spans) {
  const children = new Map();
  for (const span of spans) {
    const list = children.get(span.parent) ?? [];
    list.push(span);
    children.set(span.parent, list);
  }
  const walk = (parent, depth) => {
    for (const span of (children.get(parent) ?? []).sort((a, b) => a.start - b.start)) {
      console.log(
        `    ${"  ".repeat(depth)}${span.service.padEnd(16 - Math.min(depth * 2, 10))} ${span.name} — ${span.durationMs.toFixed(1)} мс`,
      );
      walk(span.id, depth + 1);
    }
  };
  walk(null, 0);
}

function checkIntegrity(spans, label) {
  const ids = new Set(spans.map((s) => s.id));
  const roots = spans.filter((s) => s.parent === null);
  const orphans = spans.filter((s) => s.parent !== null && !ids.has(s.parent));
  check(
    roots.length === 1 && orphans.length === 0,
    `${label}: один корень, оборванных участков нет`,
    {
      roots: roots.map((s) => `${s.service} ${s.name}`),
      orphans: orphans.map((s) => `${s.service} ${s.name}`),
    },
  );
}

console.log("\n2. Трасса оформления — через все компоненты, включая асинхронную часть");
const place = await settledTrace(
  placeTrace,
  (spans) =>
    spans.some((s) => s.name === "saga AUTHORIZE_PAYMENT") &&
    spans.some((s) => s.name.endsWith(" process")),
);
const placeServices = [...new Set(place.map((s) => s.service))].sort();
console.log(`  ${place.length} участков, сервисы: ${placeServices.join(", ")}`);
for (const service of ["gateway", "catalog", "order", "payment", "payment-provider"]) {
  check(placeServices.includes(service), `в трассе есть ${service}`);
}
check(
  place.some((s) => s.name === "saga AUTHORIZE_PAYMENT"),
  "фоновый шаг саги (холд) — в этой же трассе",
);
const publishes = place.filter((s) => s.name.endsWith(" publish"));
const processes = place.filter((s) => s.name.endsWith(" process"));
check(
  publishes.length > 0 && processes.some((p) => publishes.some((s) => s.id === p.parent)),
  `события через брокер: отправка (${publishes.length}) → обработка (${processes.length}) в той же трассе`,
);
checkIntegrity(place, "трасса оформления");
printTree(place);

console.log("\n3. Трасса отмены — с компенсацией");
const cancel = await settledTrace(cancelTrace, (spans) =>
  spans.some((s) => s.name === "saga VOID_PAYMENT"),
);
const cancelServices = [...new Set(cancel.map((s) => s.service))].sort();
console.log(`  ${cancel.length} участков, сервисы: ${cancelServices.join(", ")}`);
check(
  cancel.some((s) => s.name === "saga VOID_PAYMENT"),
  "компенсация (снятие холда) — в трассе отмены",
);
check(
  cancelServices.includes("payment-provider"),
  "снятие холда дошло до провайдера в той же трассе",
);
checkIntegrity(cancel, "трасса отмены");

console.log("\n4. Из трассы — к журналам");
const url = new URL("/loki/api/v1/query_range", loki);
url.searchParams.set("query", `{service=~".+"} | trace_id="${placeTrace}"`);
url.searchParams.set("start", String((Date.now() - 10 * 60_000) * 1e6));
url.searchParams.set("end", String((Date.now() + 5_000) * 1e6));
url.searchParams.set("limit", "1000");
const logs = await (await fetch(url)).json();
const logServices = [
  ...new Set((logs.data?.result ?? []).map((stream) => stream.stream.service)),
].sort();
check(logServices.length >= 3, `записи журнала с номером трассы: ${logServices.join(", ")}`);

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
