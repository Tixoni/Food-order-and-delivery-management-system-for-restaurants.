import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import pg from "pg";

const started = performance.now();
const flags = new Set(process.argv.slice(2));
for (const flag of flags) {
  if (!["--no-build", "--geo"].includes(flag)) throw new Error(`неизвестный аргумент: ${flag}`);
}
if (existsSync(".env")) process.loadEnvFile?.(".env");

const compose = [
  "compose",
  "--parallel",
  "2",
  ...(process.env.COMPOSE_FILE ? [] : ["-f", "infra/compose/docker-compose.yml"]),
  "--profile",
  "apps",
  "--profile",
  "observability",
  "--profile",
  "backup",
];

if (flags.has("--geo")) {
  const graph = join(process.env.OSRM_DATA_DIR ?? "infra/osrm/data", "Moscow.osrm");
  if (!existsSync(`${graph}.mldgr`) || !existsSync(`${graph}.cell_metrics`)) {
    throw new Error("карта OSRM отсутствует. Запустите npm run osrm:prepare");
  }
  compose.push("--profile", "geo");
}

function run(command, args) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")}: код ${result.status}`);
}

const runCompose = (...args) => run("docker", [...compose, ...args]);
const runScript = (script) => run(process.execPath, [script]);

async function data(database, sql) {
  const client = new pg.Client({
    host: process.env.POSTGRES_HOST ?? "localhost",
    port: Number(process.env.POSTGRES_PORT ?? 15432),
    user: process.env.POSTGRES_USER ?? "app",
    password: process.env.POSTGRES_PASSWORD ?? "app",
    database,
    connectionTimeoutMillis: 5000,
  });
  await client.connect();
  try {
    return (await client.query(sql)).rows[0];
  } finally {
    await client.end();
  }
}

runCompose(
  "up",
  "-d",
  "--wait",
  "--wait-timeout",
  "120",
  "postgres",
  "redis",
  "kafka",
  "keycloak",
  "mailpit",
);
runScript("infra/migrations/migrate.mjs");

const [catalog, delivery] = await Promise.all([
  data(
    process.env.CATALOG_DB ?? "catalog_db",
    "SELECT EXISTS(SELECT 1 FROM restaurants) AS present",
  ),
  data(
    process.env.DELIVERY_DB ?? "delivery_db",
    "SELECT EXISTS(SELECT 1 FROM couriers) AS present, EXISTS(SELECT 1 FROM couriers WHERE user_id IS NOT NULL) AS bound",
  ),
]);
if (!catalog.present && !delivery.present) {
  runScript("infra/seed/seed.mjs");
} else if (catalog.present !== delivery.present) {
  throw new Error("в тестовом стенде заполнена только одна из баз каталога и доставки");
}
if (!delivery.bound) runScript("infra/keycloak/bind-staff.mjs");

if (!flags.has("--no-build")) runCompose("build");
runCompose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120");

const url = process.env.APP_PUBLIC_URL ?? `http://localhost:${process.env.WEB_PORT ?? 13080}`;
let ready = false;
for (let attempt = 0; attempt < 20 && !ready; attempt += 1) {
  try {
    const response = await fetch(new URL("/graphql", url), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "query { restaurants(pageSize: 1) { total } }" }),
      signal: AbortSignal.timeout(3000),
    });
    ready = response.ok && (await response.json()).data?.restaurants?.total > 0;
  } catch {
    // nginx может ещё обновлять адреса только что запущенных реплик.
  }
  if (!ready) await sleep(1000);
}
if (!ready) throw new Error("витрина не получила каталог после запуска");
console.log(`Стенд готов: ${url} за ${((performance.now() - started) / 1000).toFixed(1)} с`);
