/**
 * Проверка SCAL-2: реплики шлюза и каталога равноправны и не держат
 * состояния в памяти — значит, их можно гасить и добавлять под нагрузкой.
 *
 * Под непрерывной нагрузкой через прокси реплики выключаются по очереди:
 * шлюз — штатной остановкой, вторая реплика шлюза — аварийно (kill),
 * каталог — штатно, вторая реплика каталога — аварийно. После каждой —
 * запуск и ожидание готовности. Проверяется:
 *   1. запросы витрины обслуживаются: сколько ответов с ошибкой в каждой фазе;
 *   2. нагрузка распределяется по обеим репликам — по журналу прокси;
 *   3. вход не теряется: токен и refresh-кука работают на любой реплике;
 *   4. подписка клиента на свой заказ переживает отказ реплики: graphql-ws
 *      переподключается к другой, и отмена заказа доходит до клиента;
 *   5. SEC-5 за прокси: подмена X-Forwarded-For не обходит ограничение входа.
 *
 * Окружение — профиль apps (настоящий Keycloak, NODE_ENV=production).
 * Вход — учебной учётной записью клиента из файла области Keycloak
 * (CLIENT_LOGIN / CLIENT_PASSWORD, по умолчанию client@food.local). Нужен
 * ресторан, который сейчас принимает заказы, — для проверки подписки.
 *
 * Запуск: WEB_URL=http://localhost:13080 CONTAINER_PREFIX=fd \
 *         node infra/verification/scal2-replicas.mjs
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createClient } from "graphql-ws";

const web = new URL(process.env.WEB_URL ?? "http://localhost:13080");
if (web.hostname !== "localhost" && web.hostname !== "127.0.0.1") {
  throw new Error("проверка гасит контейнеры — только на localhost");
}
const prefix = process.env.CONTAINER_PREFIX ?? "fd";
const username = process.env.CLIENT_LOGIN ?? "client@food.local";
const password = process.env.CLIENT_PASSWORD ?? "client";
const WORKERS = Number(process.env.WORKERS ?? 16);
const DOWN_MS = Number(process.env.DOWN_MS ?? 8000);

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8" }).trim();

/* ─────────── Вход и запросы ─────────── */
let accessToken = null;
let refreshCookie = null;
async function login() {
  const response = await fetch(new URL("/auth/login", web), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
  const body = await response.json();
  if (!body.accessToken) throw new Error(`вход: ${response.status}`);
  accessToken = body.accessToken;
  refreshCookie = (response.headers.getSetCookie?.() ?? [])
    .map((cookie) => cookie.split(";")[0])
    .find((cookie) => cookie.startsWith("fd_refresh="));
}

async function gql(query, variables) {
  const response = await fetch(new URL("/graphql", web), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await response.json().catch(() => null);
  if (response.status !== 200 || !body || body.errors) {
    const reason = body?.errors?.[0]?.message ?? `HTTP ${response.status}`;
    throw new Error(reason);
  }
  return body.data;
}

const NEARBY = `query($latitude: Float!, $longitude: Float!) {
  restaurantsNearby(latitude: $latitude, longitude: $longitude, limit: 20) { id name minOrderAmount }
}`;
// Случайная точка в центре Москвы: ключ кэша каждый раз новый, запрос
// доходит до каталога, а не отвечается из кэша шлюза.
const randomPoint = () => ({
  latitude: 55.73 + Math.random() * 0.05,
  longitude: 37.57 + Math.random() * 0.08,
});

/* ─────────── Нагрузка по фазам ─────────── */
const phases = [];
let phase = null;
function startPhase(name) {
  phase = { name, ok: 0, failed: 0, errors: new Map(), latencies: [] };
  phases.push(phase);
}
let running = true;
async function worker() {
  while (running) {
    const current = phase;
    const started = performance.now();
    try {
      await gql(NEARBY, randomPoint());
      current.ok += 1;
      current.latencies.push(performance.now() - started);
    } catch (error) {
      current.failed += 1;
      const key = error.message.slice(0, 80);
      current.errors.set(key, (current.errors.get(key) ?? 0) + 1);
      await sleep(50);
    }
  }
}

function healthy(container) {
  try {
    return docker("inspect", "-f", "{{.State.Health.Status}}", container) === "healthy";
  } catch {
    return false;
  }
}
async function waitHealthy(container, timeoutMs = 90_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (healthy(container)) return Date.now() - started;
    await sleep(1000);
  }
  throw new Error(`${container} не стал здоровым`);
}

/**
 * Реплика снова в ротации — прокси успешно отправил через неё запрос.
 * «Здоров» у Docker этого не значит: пока приложение загружалось, прокси
 * получал отказы в соединении и мог вывести реплику из ротации на 5 с.
 * Гасить вторую реплику раньше — значит гасить обе: в кластере это
 * правило обеспечивают проверка готовности и бюджет недоступности
 * (PodDisruptionBudget).
 */
async function waitInRotation(container, since, timeoutMs = 30_000) {
  const ip = docker(
    "inspect",
    "-f",
    "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
    container,
  );
  const served = new RegExp(
    `upstream=(?:[^ ]+, )?${ip.replaceAll(".", "\\.")}:\\d+ status=(?:\\d+, )?200`,
  );
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const log = execFileSync("docker", ["logs", "--since", since, `${prefix}-proxy`], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (served.test(log)) return Date.now() - started;
    await sleep(500);
  }
  throw new Error(`${container} не вернулся в ротацию прокси`);
}

/* ─────────── Подготовка ─────────── */
console.log("Подготовка: вход, заказ клиента, подписка на него");
await login();
check(!!accessToken && !!refreshCookie, "клиент вошёл через прокси, refresh-кука получена");

// Ресторан, который принимает заказы, и блюдо без обязательных опций
let target = null;
for (let attempt = 0; attempt < 20 && !target; attempt += 1) {
  const { restaurantsNearby } = await gql(NEARBY, randomPoint());
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
            contactPhone: "+7 900 000-00-00",
            address: { latitude: 55.7558, longitude: 37.6176, text: "Проверка SCAL-2, д. 1" },
            items: [
              {
                itemId: item.id,
                quantity: Math.max(1, Math.ceil(offer.minOrderAmount / item.price)),
              },
            ],
          },
        },
      );
      target = { orderId: placeOrder.order.id, restaurant: offer.name };
      break;
    } catch {
      // закрыт или не доставляет по адресу — следующий
    }
  }
}
if (!target) throw new Error("не нашли ресторан, который сейчас принимает заказы");
console.log(`  заказ в «${target.restaurant}»`);

let connections = 0;
const updates = [];
const wsUrl = new URL("/graphql", web);
wsUrl.protocol = "ws:";
const subscriber = createClient({
  url: wsUrl.href,
  connectionParams: () => ({ authorization: `Bearer ${accessToken}` }),
  retryAttempts: Infinity,
  shouldRetry: () => true,
  retryWait: async () => sleep(500),
  on: { connected: () => (connections += 1) },
});
subscriber.subscribe(
  {
    query: `subscription($orderId: ID!) { orderUpdated(orderId: $orderId) { status } }`,
    variables: { orderId: target.orderId },
  },
  {
    next: ({ data }) => updates.push(data.orderUpdated.status),
    error: (error) => console.log("  подписка:", error?.message ?? error),
    complete: () => undefined,
  },
);
for (let i = 0; i < 40 && connections === 0; i += 1) await sleep(250);

/* ─────────── Отказы под нагрузкой ─────────── */
console.log(`\nНагрузка: ${WORKERS} параллельных запросов витрины; реплики гасятся по очереди`);
const since = new Date().toISOString();
startPhase("обе реплики работают");
const workers = Array.from({ length: WORKERS }, () => worker());
await sleep(DOWN_MS);

const outages = [
  { container: `${prefix}-gateway`, how: "stop" },
  { container: `${prefix}-gateway-2`, how: "kill" },
  { container: `${prefix}-catalog`, how: "stop" },
  { container: `${prefix}-catalog-2`, how: "kill" },
];
const recovery = [];
for (const { container, how } of outages) {
  startPhase(`${container}: ${how === "kill" ? "аварийно (kill)" : "штатно (stop)"}`);
  docker(how, container);
  await sleep(DOWN_MS);
  startPhase(`${container}: запуск`);
  const restartedAt = new Date().toISOString();
  docker("start", container);
  const healthyMs = await waitHealthy(container);
  const rotationMs = await waitInRotation(container, restartedAt);
  recovery.push({ container, ms: healthyMs + rotationMs });
}
startPhase("обе реплики снова работают");
await sleep(DOWN_MS);
running = false;
await Promise.all(workers);

const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] ?? 0;
};
for (const p of phases) {
  const total = p.ok + p.failed;
  const errors = [...p.errors].map(([k, v]) => `${v}× ${k}`).join("; ");
  console.log(
    `  ${p.name}: ${total} запросов, ошибок ${p.failed} (${((p.failed / Math.max(total, 1)) * 100).toFixed(2)} %),` +
      ` p95 ${Math.round(percentile(p.latencies, 0.95))} мс${errors ? ` — ${errors}` : ""}`,
  );
}
for (const r of recovery)
  console.log(`  ${r.container} снова в ротации через ${(r.ms / 1000).toFixed(1)} с`);
const total = phases.reduce((sum, p) => sum + p.ok + p.failed, 0);
const failed = phases.reduce((sum, p) => sum + p.failed, 0);
const graceful = phases.filter((p) => p.name.includes("штатно") || p.name.includes("работают"));
check(
  graceful.every((p) => p.failed === 0),
  "при штатной остановке и в спокойных фазах — ни одного неудачного запроса",
);
check(
  failed / total < 0.01,
  `всего ошибок ${failed} из ${total} — меньше 1 % даже с аварийными отказами`,
);

/* ─────────── Распределение по журналу прокси ─────────── */
const ipOf = (container) =>
  docker("inspect", "-f", "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}", container);
const names = new Map(
  [`${prefix}-gateway`, `${prefix}-gateway-2`, `${prefix}-catalog`, `${prefix}-catalog-2`].map(
    (c) => [ipOf(c), c],
  ),
);
const log = execFileSync("docker", ["logs", "--since", since, `${prefix}-proxy`], {
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
  stdio: ["ignore", "pipe", "pipe"],
});
const served = new Map();
for (const match of log.matchAll(/upstream=([\d.]+):\d+ status=200/g)) {
  const name = names.get(match[1]) ?? match[1];
  served.set(name, (served.get(name) ?? 0) + 1);
}
console.log(
  "  обслужено репликами:",
  [...served].map(([name, count]) => `${name} ${count}`).join(", "),
);
check(
  [...names.values()].every((name) => (served.get(name) ?? 0) > 0),
  "нагрузку получали все четыре реплики",
);

/* ─────────── Вход и подписка пережили отказы ─────────── */
console.log("\nСостояние клиента после отказов");
const me = await gql(`query { me { id } }`).catch((error) => ({ error }));
check(!me.error, "прежний токен принимается репликами (сессия — в токене, не в памяти)");
const refreshed = await fetch(new URL("/auth/refresh", web), {
  method: "POST",
  headers: { cookie: refreshCookie },
});
check(refreshed.status === 200, `продление сеанса по refresh-куке: ${refreshed.status}`);

check(connections >= 2, `подписка переподключалась: соединений ${connections}`);
await gql(`mutation($id: ID!) { cancelOrder(id: $id, reason: "проверка SCAL-2") { status } }`, {
  id: target.orderId,
});
for (let i = 0; i < 40 && !updates.includes("CANCELLED"); i += 1) await sleep(250);
check(
  updates.includes("CANCELLED"),
  "отмена заказа дошла по подписке после отказов реплик",
  updates,
);
await subscriber.dispose();

/* ─────────── SEC-5 за прокси ─────────── */
console.log("\nSEC-5: подмена X-Forwarded-For не обходит ограничение входа");
const statuses = [];
for (let i = 0; i < 11; i += 1) {
  const response = await fetch(new URL("/auth/login", web), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-forwarded-for": `203.0.113.${i + 1}`,
    },
    body: JSON.stringify({ username, password: `${password}-неверный-${i}` }),
  });
  statuses.push(response.status);
}
check(statuses.at(-1) === 429, `11-я попытка с новым «адресом» отклонена: ${statuses.join(" ")}`);

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nПровалено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
