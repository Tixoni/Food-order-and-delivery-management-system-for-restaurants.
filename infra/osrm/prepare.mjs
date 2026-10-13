/**
 * Подготовка карты для маршрутизатора OSRM (DLV-6).
 *
 * Берёт выжимку OpenStreetMap по Москве и готовит граф дорог для
 * алгоритма MLD: извлечение (профиль «автомобиль»), разбиение, настройка.
 * Результат — в infra/osrm/data (в git не попадает), оттуда его читает
 * контейнер `osrm` из профиля geo.
 *
 * Спайк 2: карта 85 МБ, подготовка ~30 с, ~270 МБ на диске, сервер ~120 МБ ОЗУ.
 *
 * Откуда карта, по порядку:
 *   1. уже лежит в infra/osrm/data/Moscow.osm.pbf;
 *   2. файл из OSRM_PBF или скачанный спайком (spikes/02-osrm/data);
 *   3. скачивается с BBBike — с докачкой: зеркало медленное и рвёт
 *      соединение (так было на спайке).
 *
 * Запуск: npm run osrm:prepare  [-- --force — подготовить заново]
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const DATA = join(HERE, "data");
const PBF = join(DATA, "Moscow.osm.pbf");
const GRAPH = join(DATA, "Moscow.osrm");

const IMAGE = process.env.OSRM_IMAGE ?? "ghcr.io/project-osrm/osrm-backend:v26.9.0-debian";
const SOURCE_URL =
  process.env.OSRM_PBF_URL ?? "https://download.bbbike.org/osm/bbbike/Moscow/Moscow.osm.pbf";
const LOCAL_COPIES = [process.env.OSRM_PBF, join(ROOT, "spikes/02-osrm/data/Moscow.osm.pbf")];

const force = process.argv.includes("--force");

function size(path) {
  return existsSync(path) ? statSync(path).size : 0;
}

async function download(url, target, attempts = 8) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const have = size(target);
    try {
      const response = await fetch(url, { headers: have ? { Range: `bytes=${have}-` } : {} });
      if (response.status === 416) return; // файл уже целиком
      if (!response.ok) throw new Error(`ответ ${response.status}`);
      // Сервер не умеет докачку — начинаем сначала.
      const append = have > 0 && response.status === 206;
      const total = Number(response.headers.get("content-length") ?? 0) + (append ? have : 0);
      console.log(`  загрузка: ${(total / 1e6).toFixed(1)} МБ, есть ${(have / 1e6).toFixed(1)} МБ`);
      await pipeline(
        Readable.fromWeb(response.body),
        createWriteStream(target, { flags: append ? "a" : "w" }),
      );
      if (!total || size(target) >= total) return;
      throw new Error("соединение оборвалось");
    } catch (error) {
      console.warn(`  попытка ${attempt}: ${error.message}`);
      if (attempt === attempts) throw error;
      await new Promise((done) => setTimeout(done, 2000 * attempt));
    }
  }
}

function osrm(...args) {
  const started = Date.now();
  const result = spawnSync("docker", ["run", "--rm", "-v", `${DATA}:/data`, IMAGE, ...args], {
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (result.status !== 0) throw new Error(`${args[0]} завершился с кодом ${result.status}`);
  console.log(`  ${args[0]}: ${((Date.now() - started) / 1000).toFixed(1)} с`);
}

mkdirSync(DATA, { recursive: true });

if (!force && existsSync(`${GRAPH}.mldgr`) && existsSync(`${GRAPH}.cell_metrics`)) {
  console.log("Карта уже подготовлена (infra/osrm/data). Заново: npm run osrm:prepare -- --force");
  process.exit(0);
}

if (!existsSync(PBF) || size(PBF) === 0) {
  const local = LOCAL_COPIES.find((path) => path && size(path) > 0);
  if (local) {
    console.log(`Карта: копия ${local}`);
    copyFileSync(local, PBF);
  } else {
    console.log(`Карта: ${SOURCE_URL}`);
    await download(SOURCE_URL, PBF);
  }
}
console.log(`Карта: ${(size(PBF) / 1e6).toFixed(1)} МБ. Подготовка графа (${IMAGE}):`);

osrm("osrm-extract", "-p", "/opt/car.lua", "/data/Moscow.osm.pbf");
osrm("osrm-partition", "/data/Moscow.osrm");
osrm("osrm-customize", "/data/Moscow.osrm");

console.log(
  "Готово. Запуск маршрутизатора: docker compose -f infra/compose/docker-compose.yml --profile geo up -d",
);
