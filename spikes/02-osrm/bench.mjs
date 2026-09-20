/**
 * Спайк 2. Замер маршрутного движка OSRM.
 *
 * 1. Время ответа на одиночный маршрут «ресторан → клиент».
 * 2. Время ответа на матрицу «один ресторан → 10 курьеров» (запрос /table).
 * 3. Сравнение маршрутного расстояния с расстоянием по прямой —
 *    чтобы понять, насколько велика ошибка упрощённой оценки,
 *    если от OSRM придётся отказаться.
 */
const BASE = "http://localhost:5000";

// Границы Москвы в пределах МКАД
const LON_MIN = 37.4,
  LON_MAX = 37.82,
  LAT_MIN = 55.61,
  LAT_MAX = 55.88;
const rnd = (a, b) => a + Math.random() * (b - a);
const pt = () => [rnd(LON_MIN, LON_MAX), rnd(LAT_MIN, LAT_MAX)];

/** Расстояние по прямой с учётом кривизны Земли, метры. */
function haversine([lon1, lat1], [lon2, lat2]) {
  const R = 6371000,
    rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad,
    dLon = (lon2 - lon1) * rad;
  const a =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function stats(arr) {
  const s = [...arr].sort((a, b) => a - b);
  return {
    p50: s[Math.floor(s.length * 0.5)],
    p95: s[Math.floor(s.length * 0.95)],
    max: s[s.length - 1],
  };
}

const head = (s) => console.log(`\n${"=".repeat(62)}\n${s}\n${"=".repeat(62)}`);

// --- 1. Одиночные маршруты ---
head("ЗАМЕР 1. Маршрут «ресторан → клиент», 200 запросов");
const times = [],
  ratios = [],
  durations = [];
let failed = 0;

for (let i = 0; i < 200; i++) {
  const a = pt(),
    b = pt();
  const url = `${BASE}/route/v1/driving/${a[0]},${a[1]};${b[0]},${b[1]}?overview=false`;
  const t0 = performance.now();
  const res = await fetch(url);
  const json = await res.json();
  times.push(performance.now() - t0);
  if (json.code !== "Ok" || !json.routes?.length) {
    failed++;
    continue;
  }
  const route = json.routes[0];
  const straight = haversine(a, b);
  if (straight > 500) ratios.push(route.distance / straight);
  durations.push(route.duration);
}

const t1 = stats(times);
console.log(
  `  время ответа: p50 = ${t1.p50.toFixed(1)} мс, p95 = ${t1.p95.toFixed(1)} мс, макс = ${t1.max.toFixed(1)} мс`,
);
console.log(`  неуспешных запросов: ${failed} из 200`);
const d = stats(durations);
console.log(
  `  время в пути: медиана ${(d.p50 / 60).toFixed(1)} мин, p95 ${(d.p95 / 60).toFixed(1)} мин`,
);

// --- 2. Матрица до нескольких курьеров ---
head("ЗАМЕР 2. Матрица «ресторан → 10 курьеров», 100 запросов");
const tableTimes = [];
for (let i = 0; i < 100; i++) {
  const src = pt();
  const dests = Array.from({ length: 10 }, pt);
  const coords = [src, ...dests].map((p) => `${p[0]},${p[1]}`).join(";");
  const url = `${BASE}/table/v1/driving/${coords}?sources=0&annotations=duration,distance`;
  const t0 = performance.now();
  const res = await fetch(url);
  await res.json();
  tableTimes.push(performance.now() - t0);
}
const t2 = stats(tableTimes);
console.log(
  `  время ответа: p50 = ${t2.p50.toFixed(1)} мс, p95 = ${t2.p95.toFixed(1)} мс, макс = ${t2.max.toFixed(1)} мс`,
);

// --- 3. Насколько ошибается расстояние по прямой ---
head("ЗАМЕР 3. Маршрут против прямой линии");
const r = stats(ratios);
const avg = ratios.reduce((s, x) => s + x, 0) / ratios.length;
console.log(`  отношение «по дорогам / по прямой»:`);
console.log(`    среднее   = ${avg.toFixed(2)}`);
console.log(`    медиана   = ${r.p50.toFixed(2)}`);
console.log(`    95-й перц = ${r.p95.toFixed(2)}`);
console.log(`    максимум  = ${r.max.toFixed(2)}`);
const within = ratios.filter((x) => Math.abs(x - 1.3) / x < 0.15).length;
console.log(
  `  доля случаев, где коэффициент 1,3 ошибается менее чем на 15 %: ${((100 * within) / ratios.length).toFixed(0)} %`,
);

head("ИТОГ");
console.log(`  Одиночный маршрут:  p95 = ${t1.p95.toFixed(1)} мс`);
console.log(`  Матрица на 10 точек: p95 = ${t2.p95.toFixed(1)} мс`);
console.log(
  `  Запас до требования PERF-2 (800 мс на оформление заказа): ${(800 / t1.p95).toFixed(0)}-кратный`,
);
