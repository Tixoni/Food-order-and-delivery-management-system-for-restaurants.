/**
 * Применение миграций ко всем базам сервисов.
 *
 * Работает по принципу «применить недостающее»: каждая база помнит, какие
 * файлы уже выполнены, поэтому повторный запуск безопасен и ничего не ломает.
 * Это требование воспроизводимости: структура базы должна восстанавливаться
 * на любой машине одной командой, а не набором действий по памяти.
 *
 * Порядок: сначала общие миграции (служебные таблицы доставки событий),
 * затем миграции конкретной базы.
 *
 * Запуск: npm run db:migrate
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const HERE = dirname(fileURLToPath(import.meta.url));

const CONNECTION = {
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER ?? "app",
  password: process.env.POSTGRES_PASSWORD ?? "app",
};

/** База сервиса → папка с её миграциями. */
const DATABASES = [
  { database: process.env.CATALOG_DB ?? "catalog_db", folder: "catalog" },
  { database: process.env.ORDER_DB ?? "order_db", folder: "order" },
  { database: process.env.PAYMENT_DB ?? "payment_db", folder: "payment" },
  { database: process.env.DELIVERY_DB ?? "delivery_db", folder: "delivery" },
];

// Проверка одного сервиса не должна менять схемы остальных баз.
const selectedService = process.env.MIGRATION_SERVICE;
if (selectedService && !DATABASES.some((target) => target.folder === selectedService)) {
  throw new Error(`Неизвестный сервис для миграции: ${selectedService}`);
}
const targets = selectedService
  ? DATABASES.filter((target) => target.folder === selectedService)
  : DATABASES;

const TRACKING_TABLE = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    filename   TEXT PRIMARY KEY,
    applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`;

function collect(folder) {
  const path = join(HERE, folder);
  try {
    return readdirSync(path)
      .filter((f) => f.endsWith(".sql"))
      .sort()
      .map((f) => ({ name: `${folder}/${f}`, sql: readFileSync(join(path, f), "utf8") }));
  } catch {
    return []; // папки может не быть, пока у сервиса нет своих таблиц
  }
}

async function migrate({ database, folder }) {
  const client = new pg.Client({ ...CONNECTION, database });
  await client.connect();

  try {
    await client.query(TRACKING_TABLE);
    const { rows } = await client.query("SELECT filename FROM schema_migrations");
    const applied = new Set(rows.map((r) => r.filename));

    const pending = [...collect("common"), ...collect(folder)].filter((m) => !applied.has(m.name));

    if (pending.length === 0) {
      console.log(`  ${database}: изменений нет`);
      return;
    }

    for (const migration of pending) {
      // Каждая миграция — в своей транзакции: при ошибке откатывается
      // целиком, и база не остаётся в промежуточном состоянии.
      await client.query("BEGIN");
      try {
        await client.query(migration.sql);
        await client.query("INSERT INTO schema_migrations (filename) VALUES ($1)", [
          migration.name,
        ]);
        await client.query("COMMIT");
        console.log(`  ${database}: применена ${migration.name}`);
      } catch (error) {
        await client.query("ROLLBACK");
        throw new Error(`${database}, ${migration.name}: ${error.message}`);
      }
    }
  } finally {
    await client.end();
  }
}

console.log(`Применение миграций (${CONNECTION.host}:${CONNECTION.port})`);

let failed = false;
for (const target of targets) {
  try {
    await migrate(target);
  } catch (error) {
    console.error(`  ОШИБКА: ${error.message}`);
    failed = true;
  }
}

if (failed) {
  console.error("\nМиграции применены не полностью.");
  process.exitCode = 1;
} else {
  console.log("\nВсе базы в актуальном состоянии.");
}
