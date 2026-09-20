/**
 * Дополнение к спайку 1: проверка на объёме, близком к целевому.
 *
 * На 500 зонах пространственный индекс не даёт выигрыша — планировщик
 * всё равно выбирает последовательный просмотр, потому что таблица мала.
 * Проверяем, начиная с какого объёма индекс действительно нужен,
 * и сохраняется ли требование PERF-5.
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

const CLIENT_LON = 37.6176;
const CLIENT_LAT = 55.7558;
const RADIUS_M = 3000;

const head = (s: string) => console.log(`\n${"=".repeat(64)}\n${s}\n${"=".repeat(64)}`);

async function measure(label: string, runs: number, fn: () => Promise<unknown>) {
  await fn();
  const t: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn();
    t.push(performance.now() - t0);
  }
  t.sort((a, b) => a - b);
  const p50 = t[Math.floor(runs * 0.5)];
  const p95 = t[Math.floor(runs * 0.95)];
  console.log(`  ${label}: p50 = ${p50.toFixed(1)} мс, p95 = ${p95.toFixed(1)} мс`);
  return p95;
}

/** Наполнение сырым SQL — быстрее, чем через репозиторий; измеряем не вставку, а выборку. */
async function seedRaw(zones: number, couriers: number) {
  await ds.query("TRUNCATE delivery_zones, restaurants, couriers");
  await ds.query(
    `INSERT INTO restaurants (id, name, location)
     SELECT gen_random_uuid(), 'Ресторан №' || i,
            ST_SetSRID(ST_MakePoint(37.37 + random()*0.48, 55.58 + random()*0.33), 4326)::geography
     FROM generate_series(1, $1) AS i`,
    [zones],
  );
  await ds.query(
    `INSERT INTO delivery_zones (id, "restaurantId", area, "deliveryFee")
     SELECT gen_random_uuid(), r.id,
            ST_MakeEnvelope(
              ST_X(r.location::geometry) - 0.012 - random()*0.018,
              ST_Y(r.location::geometry) - 0.012 - random()*0.018,
              ST_X(r.location::geometry) + 0.012 + random()*0.018,
              ST_Y(r.location::geometry) + 0.012 + random()*0.018,
              4326)::geography,
            99 + floor(random()*250)
     FROM restaurants r`,
  );
  await ds.query(
    `INSERT INTO couriers (id, name, status, "lastLocation")
     SELECT gen_random_uuid(), 'Курьер №' || i,
            CASE WHEN random() < 0.6 THEN 'available' ELSE 'busy' END,
            ST_SetSRID(ST_MakePoint(37.37 + random()*0.48, 55.58 + random()*0.33), 4326)::geography
     FROM generate_series(1, $1) AS i`,
    [couriers],
  );
  await ds.query("ANALYZE");
}

const qCat1 = () =>
  ds
    .getRepository(DeliveryZone)
    .createQueryBuilder("zone")
    .select(["zone.id"])
    .where(
      "ST_Contains(zone.area::geometry, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geometry)",
      {
        lon: CLIENT_LON,
        lat: CLIENT_LAT,
      },
    )
    .getRawMany();

const qDlv3 = () =>
  ds
    .getRepository(Courier)
    .createQueryBuilder("c")
    .select(["c.id"])
    .addSelect(
      "ST_Distance(c.lastLocation, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography)",
      "d",
    )
    .where("c.status = :status", { status: "available" })
    .andWhere(
      "ST_DWithin(c.lastLocation, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326)::geography, :radius)",
      { lon: CLIENT_LON, lat: CLIENT_LAT, radius: RADIUS_M },
    )
    .orderBy("d", "ASC")
    .limit(5)
    .setParameters({ lon: CLIENT_LON, lat: CLIENT_LAT })
    .getRawMany();

async function ensureIndexes() {
  await ds.query(`CREATE INDEX IF NOT EXISTS ix_zone_area ON delivery_zones USING GIST (area)`);
  await ds.query(
    `CREATE INDEX IF NOT EXISTS ix_courier_loc ON couriers USING GIST ("lastLocation")`,
  );
  await ds.query("ANALYZE");
}

async function dropIndexes() {
  await ds.query(`DROP INDEX IF EXISTS ix_zone_area`);
  await ds.query(`DROP INDEX IF EXISTS ix_courier_loc`);
  await ds.query("ANALYZE");
}

async function main() {
  await ds.initialize();

  for (const [zones, couriers] of [
    [500, 200],
    [5_000, 2_000],
    [50_000, 20_000],
  ] as const) {
    head(
      `ОБЪЁМ: ${zones.toLocaleString("ru")} зон доставки, ${couriers.toLocaleString("ru")} курьеров`,
    );
    await seedRaw(zones, couriers);

    await ensureIndexes();
    const cat1With = await measure("CAT-1 с индексом GiST ", 30, qCat1);
    const dlv3With = await measure("DLV-3 с индексом GiST ", 30, qDlv3);

    await dropIndexes();
    const cat1No = await measure("CAT-1 без индекса     ", 30, qCat1);
    const dlv3No = await measure("DLV-3 без индекса     ", 30, qDlv3);

    console.log(
      `  → выигрыш от индекса: CAT-1 в ${(cat1No / cat1With).toFixed(1)} раза, ` +
        `DLV-3 в ${(dlv3No / dlv3With).toFixed(1)} раза`,
    );
    console.log(
      `  → PERF-5 (≤ 150 мс) с индексом: ${cat1With <= 150 ? "выполняется" : "НЕ выполняется"}`,
    );

    await ensureIndexes();
    const plan = await ds.query(
      `EXPLAIN SELECT id FROM delivery_zones
       WHERE ST_Contains(area::geometry, ST_SetSRID(ST_MakePoint($1,$2),4326)::geometry)`,
      [CLIENT_LON, CLIENT_LAT],
    );
    console.log("  план с индексом: " + plan[0]["QUERY PLAN"].trim());
  }

  await ds.destroy();
}

main().catch((e) => {
  console.error("\nОШИБКА:\n", e);
  process.exit(1);
});
