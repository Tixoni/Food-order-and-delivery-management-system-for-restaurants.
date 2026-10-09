/**
 * Интерактивная проверка восстановления outbox после остановки Kafka.
 * Только localhost и отдельная *_verify_db. На подсказках STOP/START
 * оператор останавливает/запускает свой тестовый контейнер Kafka и жмёт Enter.
 */
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import pg from "pg";

const catalog = new URL(process.env.CATALOG_VERIFY_URL ?? "http://localhost:13102");
const databaseUrl = process.env.CATALOG_VERIFY_DB_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_verify_db")) {
  throw new Error("нужна отдельная база с именем *_verify_db");
}
if (catalog.hostname !== "localhost") {
  throw new Error("проверка с фиктивными токенами допускается только на localhost");
}

const token = (roles, restaurantId) =>
  `e30.${Buffer.from(JSON.stringify({ sub: randomUUID(), realm_access: { roles }, restaurantId })).toString("base64url")}.x`;

async function request(base, path, method = "GET", body, accessToken) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}

async function waitUntil(check, timeoutMs, message) {
  const started = performance.now();
  while (performance.now() - started < timeoutMs) {
    if (await check()) return Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(message);
}

const db = new pg.Client({ connectionString: databaseUrl });
const input = createInterface({ input: process.stdin, output: process.stdout });
let restaurantId;
let itemId;
try {
  await db.connect();
  await waitUntil(
    async () => {
      try {
        return (await fetch(new URL("/ready", catalog), { signal: AbortSignal.timeout(1000) })).ok;
      } catch {
        return false;
      }
    },
    15000,
    "Catalog не готов",
  );
  const admin = token(["admin"]);
  const created = await request(
    catalog,
    "/restaurants",
    "POST",
    {
      name: `Outbox recovery ${randomUUID().slice(0, 8)}`,
    },
    admin,
  );
  if (created.status !== 201) throw new Error(`restaurant: ${JSON.stringify(created)}`);
  restaurantId = created.body.id;
  const manager = token(["manager"], restaurantId);
  const category = await request(
    catalog,
    `/restaurants/${restaurantId}/menu/categories`,
    "POST",
    {
      name: "Проверка",
    },
    manager,
  );
  if (category.status !== 201) throw new Error(`category: ${JSON.stringify(category)}`);
  const item = await request(
    catalog,
    `/restaurants/${restaurantId}/menu/items`,
    "POST",
    {
      categoryId: category.body.id,
      name: "Проверочное блюдо",
      price: 20000,
    },
    manager,
  );
  if (item.status !== 201) throw new Error(`item: ${JSON.stringify(item)}`);
  itemId = item.body.id;

  if (process.env.CATALOG_VERIFY_STARTUP_OUTAGE === "true") {
    await input.question("START_INITIAL_KAFKA: запустите Kafka, затем нажмите Enter\n");
  }

  await waitUntil(
    async () => {
      const rows = await db.query(
        "SELECT count(*)::int AS pending FROM outbox_messages WHERE payload->'payload'->>'restaurantId' = $1 AND published_at IS NULL",
        [restaurantId],
      );
      return rows.rows[0].pending === 0;
    },
    10000,
    "начальные события не опубликованы",
  );

  await input.question("STOP_KAFKA: остановите только тестовый Kafka, затем нажмите Enter\n");
  const stopped = await request(
    catalog,
    `/menu/items/${itemId}/availability`,
    "PATCH",
    {
      restaurantId,
      isAvailable: false,
      reason: "проверка восстановления брокера",
    },
    manager,
  );
  if (stopped.status !== 200) throw new Error(`stop list: ${JSON.stringify(stopped)}`);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const pending = await db.query(
    "SELECT published_at FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'MenuItemStopped'",
    [itemId],
  );
  if (pending.rows.length !== 1 || pending.rows[0].published_at !== null) {
    throw new Error("событие не осталось в outbox при выключенном Kafka");
  }

  await input.question("START_KAFKA: запустите Kafka, затем нажмите Enter\n");
  const replayedAfterMs = await waitUntil(
    async () => {
      const rows = await db.query(
        "SELECT published_at FROM outbox_messages WHERE aggregate_id = $1 AND event_type = 'MenuItemStopped'",
        [itemId],
      );
      return rows.rows.length === 1 && rows.rows[0].published_at !== null;
    },
    30000,
    "событие не было отправлено после восстановления Kafka",
  );

  console.log(JSON.stringify({ pendingWhileKafkaDown: true, replayedAfterMs }));
} finally {
  input.close();
  if (restaurantId) {
    await db.query("DELETE FROM outbox_messages WHERE payload->'payload'->>'restaurantId' = $1", [
      restaurantId,
    ]);
    await db.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
  }
  await db.end().catch(() => undefined);
}
