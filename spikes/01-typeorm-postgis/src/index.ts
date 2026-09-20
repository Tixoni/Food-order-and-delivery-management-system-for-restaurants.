/**
 * Спайк 1. Работает ли TypeORM с географическими типами PostGIS?
 *
 * Проверяем три вещи:
 *   1. Описываются ли географические колонки средствами TypeORM (entities.ts).
 *   2. Можно ли писать и читать значения через обычный репозиторий.
 *   3. Можно ли выполнять пространственные запросы, и если да — то как:
 *      через API репозитория или только через вставки сырого SQL.
 *
 * Дополнительно замеряем время запросов с пространственным индексом и без него,
 * чтобы проверить достижимость требования PERF-5 (геозапрос ≤ 150 мс).
 */
import "reflect-metadata";
import { DataSource } from "typeorm";
import { Courier, DeliveryZone, Restaurant } from "./entities.js";
import { seed } from "./seed.js";

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

/** Адрес клиента: точка в центре Москвы. */
const CLIENT_LON = 37.6176;
const CLIENT_LAT = 55.7558;
const RADIUS_M = 3000;

const ok = (s: string) => console.log(`  ✓ ${s}`);
const fail = (s: string) => console.log(`  ✗ ${s}`);
const head = (s: string) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);

async function measure<T>(label: string, runs: number, fn: () => Promise<T>) {
  await fn(); // прогрев
  const times: number[] = [];
  let last: T | undefined;
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    last = await fn();
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p50 = times[Math.floor(runs * 0.5)];
  const p95 = times[Math.floor(runs * 0.95)];
  console.log(
    `  ${label}: p50 = ${p50.toFixed(1)} мс, p95 = ${p95.toFixed(1)} мс ` +
      `(мин ${times[0].toFixed(1)}, макс ${times[runs - 1].toFixed(1)})`,
  );
  return { p50, p95, last };
}

async function main() {
  head("ПОДГОТОВКА");
  await ds.initialize();
  ok("соединение с базой установлено");

  await ds.query("CREATE EXTENSION IF NOT EXISTS postgis");
  const [{ version }] = await ds.query("SELECT postgis_version() AS version");
  ok(`расширение PostGIS доступно: ${version}`);

  await ds.synchronize(true);
  ok("схема создана средствами TypeORM (synchronize)");

  const idx = await ds.query(`
    SELECT indexname, indexdef FROM pg_indexes
    WHERE tablename IN ('restaurants','delivery_zones','couriers')
      AND indexdef ILIKE '%gist%'
    ORDER BY indexname
  `);
  if (idx.length) {
    ok(`TypeORM создал пространственные индексы: ${idx.length} шт.`);
    for (const i of idx) console.log(`      ${i.indexname}`);
  } else {
    fail("пространственные индексы НЕ созданы");
  }

  head("ПРОВЕРКА 1. Запись и чтение географических значений через репозиторий");
  const counts = await seed(ds, 500, 200);
  ok(
    `данные записаны: ${counts.restaurants} ресторанов, ${counts.zones} зон, ${counts.couriers} курьеров`,
  );

  const sample = await ds.getRepository(Restaurant).findOne({ where: {} });
  if (sample?.location?.type === "Point" && Array.isArray(sample.location.coordinates)) {
    ok(`чтение вернуло GeoJSON: ${JSON.stringify(sample.location)}`);
  } else {
    fail(`чтение вернуло неожиданный формат: ${JSON.stringify(sample?.location)}`);
  }

  head("ПРОВЕРКА 2. Запрос CAT-1 — какие рестораны доставляют по адресу");
  let zonesFound = 0;
  const qCat1 = async () => {
    const rows = await ds
      .getRepository(DeliveryZone)
      .createQueryBuilder("zone")
      .innerJoin(Restaurant, "r", "r.id = zone.restaurantId")
      .select(["zone.id", "zone.deliveryFee", "r.name"])
      .where(
        "ST_Contains(zone.area::geometry, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geometry)",
        { lon: CLIENT_LON, lat: CLIENT_LAT },
      )
      .getRawMany();
    zonesFound = rows.length;
    return rows;
  };
  const cat1 = await measure("с индексом GiST", 50, qCat1);
  ok(`найдено ресторанов, доставляющих по адресу: ${zonesFound}`);

  head("ПРОВЕРКА 3. Запрос DLV-3 — свободные курьеры в радиусе 3 км");
  let couriersFound = 0;
  const qDlv3 = async () => {
    const rows = await ds
      .getRepository(Courier)
      .createQueryBuilder("c")
      .select(["c.id", "c.name"])
      .addSelect(
        "ST_Distance(c.lastLocation, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography)",
        "distance_m",
      )
      .where("c.status = :status", { status: "available" })
      .andWhere(
        "ST_DWithin(c.lastLocation, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :radius)",
        { lon: CLIENT_LON, lat: CLIENT_LAT, radius: RADIUS_M },
      )
      .orderBy("distance_m", "ASC")
      .limit(5)
      .setParameters({ lon: CLIENT_LON, lat: CLIENT_LAT })
      .getRawMany();
    couriersFound = rows.length;
    return rows;
  };
  const dlv3 = await measure("с индексом GiST", 50, qDlv3);
  const nearest = await qDlv3();
  ok(`ближайших свободных курьеров: ${couriersFound}`);
  for (const c of nearest) {
    console.log(`      ${c.c_name} — ${Math.round(Number(c.distance_m))} м`);
  }

  head("ПРОВЕРКА 4. Тот же запрос без пространственного индекса");
  const dropped: string[] = [];
  for (const i of idx) {
    await ds.query(`DROP INDEX IF EXISTS "${i.indexname}"`);
    dropped.push(i.indexname);
  }
  await ds.query("ANALYZE");
  console.log(`  индексы удалены: ${dropped.length}`);
  const cat1NoIdx = await measure("без индекса", 50, qCat1);
  const dlv3NoIdx = await measure("без индекса", 50, qDlv3);

  head("ПЛАН ВЫПОЛНЕНИЯ ЗАПРОСА (без индекса)");
  const plan = await ds.query(
    `EXPLAIN ANALYZE SELECT zone.id FROM delivery_zones zone
     WHERE ST_Contains(zone.area::geometry, ST_SetSRID(ST_MakePoint($1,$2),4326)::geometry)`,
    [CLIENT_LON, CLIENT_LAT],
  );
  for (const line of plan) console.log("  " + line["QUERY PLAN"]);

  head("ИТОГ");
  console.log(
    `  CAT-1  с индексом: p95 = ${cat1.p95.toFixed(1)} мс   без индекса: p95 = ${cat1NoIdx.p95.toFixed(1)} мс`,
  );
  console.log(
    `  DLV-3  с индексом: p95 = ${dlv3.p95.toFixed(1)} мс   без индекса: p95 = ${dlv3NoIdx.p95.toFixed(1)} мс`,
  );
  console.log(
    `  Требование PERF-5 (≤ 150 мс): ${cat1.p95 <= 150 ? "ВЫПОЛНЯЕТСЯ" : "НЕ ВЫПОЛНЯЕТСЯ"}`,
  );

  await ds.destroy();
}

main().catch((e) => {
  console.error("\nСПАЙК ЗАВЕРШИЛСЯ ОШИБКОЙ:\n", e);
  process.exit(1);
});
