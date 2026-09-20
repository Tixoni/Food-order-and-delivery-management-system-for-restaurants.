/**
 * Разбор находки: почему индекс по зонам доставки не используется.
 *
 * Гипотеза: приведение колонки к другому типу внутри условия
 * (area::geometry) делает индекс по geography неприменимым — база
 * вынуждена вычислять выражение для каждой строки.
 *
 * Проверяем три варианта записи одного и того же запроса CAT-1.
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Courier, DeliveryZone, Restaurant } from "./entities.js";

const ds = new DataSource({
  type: "postgres",
  host: "localhost",
  port: 55432,
  username: "spike",
  password: "spike",
  database: "spike",
  entities: [Restaurant, DeliveryZone, Courier],
  synchronize: false,
  logging: false,
});

const LON = 37.6176;
const LAT = 55.7558;

const head = (s: string) => console.log(`\n${"─".repeat(64)}\n${s}\n${"─".repeat(64)}`);

async function measure(label: string, sql: string) {
  await ds.query(sql, [LON, LAT]);
  const t: number[] = [];
  let rows: unknown[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    rows = await ds.query(sql, [LON, LAT]);
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  const plan = await ds.query("EXPLAIN " + sql, [LON, LAT]);
  console.log(`  ${label}`);
  console.log(
    `    p50 = ${t[15].toFixed(1)} мс, p95 = ${t[28].toFixed(1)} мс, найдено строк: ${rows.length}`,
  );
  console.log(`    план: ${plan[0]["QUERY PLAN"].trim()}`);
  return t[28];
}

async function main() {
  await ds.initialize();
  const [{ count }] = await ds.query("SELECT count(*)::int AS count FROM delivery_zones");
  console.log(`Объём данных: ${count.toLocaleString("ru")} зон доставки`);

  await ds.query(`CREATE INDEX IF NOT EXISTS ix_zone_area ON delivery_zones USING GIST (area)`);
  await ds.query(`DROP INDEX IF EXISTS ix_zone_area_geom`);
  await ds.query("ANALYZE");

  head("ВАРИАНТ 1. ST_Contains с приведением типа — как было написано изначально");
  const v1 = await measure(
    "ST_Contains(area::geometry, точка::geometry)",
    `SELECT id FROM delivery_zones
     WHERE ST_Contains(area::geometry, ST_SetSRID(ST_MakePoint($1,$2),4326)::geometry)`,
  );

  head("ВАРИАНТ 2. ST_Intersects без приведения — работает с типом geography напрямую");
  const v2 = await measure(
    "ST_Intersects(area, точка::geography)",
    `SELECT id FROM delivery_zones
     WHERE ST_Intersects(area, ST_SetSRID(ST_MakePoint($1,$2),4326)::geography)`,
  );

  head("ВАРИАНТ 3. ST_Contains + индекс по выражению (area::geometry)");
  await ds.query(
    `CREATE INDEX IF NOT EXISTS ix_zone_area_geom ON delivery_zones USING GIST ((area::geometry))`,
  );
  await ds.query("ANALYZE");
  const v3 = await measure(
    "ST_Contains(area::geometry, точка::geometry) + индекс по выражению",
    `SELECT id FROM delivery_zones
     WHERE ST_Contains(area::geometry, ST_SetSRID(ST_MakePoint($1,$2),4326)::geometry)`,
  );

  head("ИТОГ");
  console.log(`  Вариант 1 (приведение, обычный индекс):      p95 = ${v1.toFixed(1)} мс`);
  console.log(
    `  Вариант 2 (ST_Intersects по geography):      p95 = ${v2.toFixed(1)} мс  — быстрее в ${(v1 / v2).toFixed(1)} раза`,
  );
  console.log(
    `  Вариант 3 (индекс по выражению):             p95 = ${v3.toFixed(1)} мс  — быстрее в ${(v1 / v3).toFixed(1)} раза`,
  );

  await ds.destroy();
}

main().catch((e) => {
  console.error("\nОШИБКА:\n", e);
  process.exit(1);
});
