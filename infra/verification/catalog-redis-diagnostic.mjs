/** Диагностика выдачи при выключенном Redis на отдельной тестовой БД. */
import { randomUUID } from "node:crypto";
import pg from "pg";

const databaseUrl = process.env.CATALOG_VERIFY_DB_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_verify_db")) {
  throw new Error("нужна отдельная база *_verify_db");
}
const catalog = new URL(process.env.CATALOG_VERIFY_URL ?? "http://localhost:13102");
const gateway = new URL(process.env.GATEWAY_VERIFY_URL ?? "http://localhost:13103");
if (catalog.hostname !== "localhost" || gateway.hostname !== "localhost") {
  throw new Error("проверка допускается только на localhost");
}

const db = new pg.Client({ connectionString: databaseUrl });
let restaurantId;
const timed = async (name, url, options) => {
  const started = performance.now();
  try {
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(15000) });
    const body = await response.json();
    console.log(
      JSON.stringify({
        name,
        status: response.status,
        ms: Math.round(performance.now() - started),
        body,
      }),
    );
    return { response, body };
  } catch (error) {
    console.log(
      JSON.stringify({
        name,
        error: error instanceof Error ? error.message : String(error),
        ms: Math.round(performance.now() - started),
      }),
    );
    return null;
  }
};

try {
  await db.connect();
  const token = `e30.${Buffer.from(JSON.stringify({ sub: randomUUID(), realm_access: { roles: ["admin"] } })).toString("base64url")}.x`;
  const created = await timed("create", new URL("/restaurants", catalog), {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ name: `Redis diagnostic ${randomUUID().slice(0, 8)}` }),
  });
  if (created?.response.status !== 201) throw new Error("не удалось создать ресторан");
  restaurantId = created.body.id;
  await timed("catalog-list", new URL("/restaurants?page=1&pageSize=50", catalog));
  await timed("gateway-list", new URL("/graphql", gateway), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: "{ restaurants(page: 1, pageSize: 50) { items { id name } } }" }),
  });
} finally {
  if (restaurantId) {
    await db.query("DELETE FROM outbox_messages WHERE payload->'payload'->>'restaurantId' = $1", [
      restaurantId,
    ]);
    await db.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
  }
  await db.end().catch(() => undefined);
}
