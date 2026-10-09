/**
 * Изолированная проверка Catalog → Kafka → Gateway на тестовой базе.
 * Требует запущенных проверочных контейнеров с AUTH_DISABLED=true;
 * фиктивные токены допустимы только в таком локальном окружении.
 */
import { randomUUID } from "node:crypto";
import pg from "pg";

const catalog = new URL(process.env.CATALOG_VERIFY_URL ?? "http://localhost:13102");
const gateway = new URL(process.env.GATEWAY_VERIFY_URL ?? "http://localhost:13103");
const secondGateway = process.env.GATEWAY_VERIFY_SECOND_URL
  ? new URL(process.env.GATEWAY_VERIFY_SECOND_URL)
  : null;
const gateways = secondGateway ? [gateway, secondGateway] : [gateway];
const expectRedisDown = process.env.CATALOG_VERIFY_REDIS_DOWN === "true";
const databaseUrl = process.env.CATALOG_VERIFY_DB_URL;
if (!databaseUrl || !new URL(databaseUrl).pathname.endsWith("_verify_db")) {
  throw new Error("нужна отдельная база с именем *_verify_db");
}
if (catalog.hostname !== "localhost" || gateways.some((url) => url.hostname !== "localhost")) {
  throw new Error("проверка с фиктивными токенами допускается только на localhost");
}

const token = (roles, restaurantId) => {
  const payload = { sub: randomUUID(), realm_access: { roles }, restaurantId };
  return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.x`;
};

async function request(base, path, method = "GET", body, accessToken) {
  const response = await fetch(new URL(path, base), {
    method,
    headers: {
      ...(body ? { "content-type": "application/json" } : {}),
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const result = await response.json();
  return { status: response.status, result };
}

async function graphql(query, variables, base = gateway) {
  const response = await request(base, "/graphql", "POST", {
    query,
    variables,
  });
  if (response.status !== 200 || response.result.errors) {
    throw new Error(`GraphQL failed: ${JSON.stringify(response)}`);
  }
  return response.result.data;
}

async function menu(restaurantId, base = gateway) {
  const data = await graphql(
    "query($id: ID!) { menu(restaurantId: $id) { categories { items { id imageUrl optionGroups { name options { name priceDelta } } } } } }",
    { id: restaurantId },
    base,
  );
  return data.menu.categories.flatMap((category) => category.items);
}

async function restaurantPage(base = gateway) {
  const data = await graphql(
    "{ restaurants(page: 1, pageSize: 50) { items { id name } } }",
    {},
    base,
  );
  return data.restaurants.items;
}

async function nearby(base = gateway) {
  const data = await graphql(
    "{ restaurantsNearby(latitude: 55.75, longitude: 37.62) { id name zone { id } } }",
    {},
    base,
  );
  return data.restaurantsNearby;
}

async function waitUntil(check, message) {
  const started = performance.now();
  while (performance.now() - started < 5000) {
    if (await check()) return Math.round(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(message);
}

async function everyGateway(check) {
  return (await Promise.all(gateways.map(check))).every(Boolean);
}

async function waitForServices() {
  for (const base of [catalog, ...gateways]) {
    const started = performance.now();
    let ready = false;
    while (performance.now() - started < 30000) {
      try {
        const response = await fetch(new URL("/ready", base), {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          ready = true;
          break;
        }
      } catch {
        // Контейнер ещё запускается.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    if (!ready) throw new Error(`сервис не готов: ${base.origin}`);
  }
}

function cacheReads(metrics, cache, result) {
  return metrics
    .split("\n")
    .filter(
      (line) =>
        line.startsWith("cache_reads_total{") &&
        line.includes(`cache="${cache}"`) &&
        line.includes(`result="${result}"`),
    )
    .reduce((sum, line) => sum + Number(line.trim().split(/\s+/).at(-1)), 0);
}

/** Ограниченный локальный профиль чтений на тестовом ресторане. */
async function loadMenu(restaurantId) {
  const rps = Number(process.env.CATALOG_VERIFY_LOAD_RPS ?? 0);
  if (rps === 0) return null;
  if (expectRedisDown) throw new Error("нагрузочный режим требует доступного Redis");
  const profile = process.env.CATALOG_VERIFY_LOAD_PROFILE ?? "catalog-menu";
  if (!["catalog-menu", "gateway-mixed"].includes(profile)) {
    throw new Error("неизвестный CATALOG_VERIFY_LOAD_PROFILE");
  }
  const seconds = Number(process.env.CATALOG_VERIFY_LOAD_SECONDS ?? 10);
  if (
    !Number.isInteger(rps) ||
    rps < 1 ||
    rps > 250 ||
    !Number.isInteger(seconds) ||
    seconds < 1 ||
    seconds > 20
  ) {
    throw new Error("нагрузочный режим допускает 1–250 запросов/с и 1–20 секунд");
  }

  const path = `/restaurants/${restaurantId}/menu`;
  const url = new URL(path, catalog);
  const gatewayQueries = [
    {
      query: "query($id: ID!) { menu(restaurantId: $id) { categories { items { id } } } }",
      variables: { id: restaurantId },
    },
    { query: "{ restaurants(page: 1, pageSize: 50) { items { id } } }" },
    { query: "{ restaurantsNearby(latitude: 55.75, longitude: 37.62) { id } }" },
  ];
  const metricsBase = profile === "gateway-mixed" ? gateway : catalog;
  if (profile === "gateway-mixed") {
    for (const entry of gatewayQueries) await graphql(entry.query, entry.variables ?? {});
  } else {
    await request(catalog, path);
  }
  const before = await (await fetch(new URL("/metrics", metricsBase))).text();
  const latencies = [];
  let errors = 0;
  const jobs = [];
  const started = performance.now();
  for (let index = 0; index < rps * seconds; index += 1) {
    const wait = started + (index * 1000) / rps - performance.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    jobs.push(
      (async () => {
        const requestStarted = performance.now();
        try {
          const response =
            profile === "gateway-mixed"
              ? await fetch(new URL("/graphql", gateway), {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify(gatewayQueries[index % gatewayQueries.length]),
                })
              : await fetch(url);
          const body = await response.text();
          if (!response.ok || (profile === "gateway-mixed" && JSON.parse(body).errors)) errors += 1;
        } catch {
          errors += 1;
        }
        latencies.push(performance.now() - requestStarted);
      })(),
    );
  }
  await Promise.all(jobs);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const after = await (await fetch(new URL("/metrics", metricsBase))).text();
  const cacheNames = profile === "gateway-mixed" ? ["menu", "listing"] : ["menu"];
  const delta = (result) =>
    cacheNames.reduce(
      (sum, cache) => sum + cacheReads(after, cache, result) - cacheReads(before, cache, result),
      0,
    );
  const hits = delta("hit");
  const misses = delta("miss");
  const cacheErrors = delta("error");
  latencies.sort((a, b) => a - b);
  const p95Ms = Math.round(latencies[Math.ceil(latencies.length * 0.95) - 1]);
  const achievedRps = Math.round(latencies.length / elapsedSeconds);
  const hitRatio = hits / (hits + misses + cacheErrors);
  const result = {
    profile,
    targetRps: rps,
    achievedRps,
    seconds,
    p95Ms,
    hitRatio: Number(hitRatio.toFixed(4)),
    errors,
  };
  if (
    errors > 0 ||
    achievedRps < rps * 0.95 ||
    p95Ms > 300 ||
    !Number.isFinite(hitRatio) ||
    hitRatio < 0.8
  ) {
    throw new Error(`нагрузочная проверка не прошла: ${JSON.stringify(result)}`);
  }
  return result;
}

const db = new pg.Client({ connectionString: databaseUrl });
let restaurantId;
let itemId;
try {
  await waitForServices();
  const admin = token(["admin"]);
  const created = await request(
    catalog,
    "/restaurants",
    "POST",
    {
      name: `Проверка каталога ${randomUUID().slice(0, 8)}`,
      minOrderAmount: 10000,
      deliveryFeeBase: 0,
    },
    admin,
  );
  if (created.status !== 201) throw new Error(`restaurant: ${JSON.stringify(created)}`);
  restaurantId = created.result.id;
  const manager = token(["manager"], restaurantId);

  const category = await request(
    catalog,
    `/restaurants/${restaurantId}/menu/categories`,
    "POST",
    { name: "Проверка" },
    manager,
  );
  if (category.status !== 201) throw new Error(`category: ${JSON.stringify(category)}`);
  const item = await request(
    catalog,
    `/restaurants/${restaurantId}/menu/items`,
    "POST",
    {
      categoryId: category.result.id,
      name: "Проверочное блюдо",
      price: 20000,
      imageUrl: "https://example.org/verification.jpg",
    },
    manager,
  );
  if (item.status !== 201) throw new Error(`item: ${JSON.stringify(item)}`);
  itemId = item.result.id;

  const groups = await request(
    catalog,
    `/menu/items/${itemId}/modifiers`,
    "PUT",
    {
      restaurantId,
      groups: [
        {
          name: "Размер",
          selectionType: "single",
          isRequired: true,
          minSelect: 1,
          maxSelect: 1,
          options: [{ name: "Большой", priceDelta: 5000 }],
        },
      ],
    },
    manager,
  );
  if (groups.status !== 200) throw new Error(`modifiers: ${JSON.stringify(groups)}`);
  const schedule = await request(
    catalog,
    `/restaurants/${restaurantId}/schedule`,
    "PUT",
    {
      intervals: Array.from({ length: 7 }, (_, dayOfWeek) => ({
        dayOfWeek,
        opensAt: "00:00",
        closesAt: "23:59",
      })),
    },
    manager,
  );
  if (schedule.status !== 200) throw new Error(`schedule: ${JSON.stringify(schedule)}`);
  const zone = await request(
    catalog,
    `/restaurants/${restaurantId}/zones`,
    "POST",
    {
      name: "Центр",
      deliveryFee: 10000,
      minOrderAmount: 10000,
      ring: [
        { latitude: 55.7, longitude: 37.5 },
        { latitude: 55.7, longitude: 37.7 },
        { latitude: 55.8, longitude: 37.7 },
        { latitude: 55.8, longitude: 37.5 },
      ],
    },
    manager,
  );
  if (zone.status !== 201) throw new Error(`zone: ${JSON.stringify(zone)}`);

  if (
    !(await everyGateway(async (base) =>
      (await restaurantPage(base)).some((entry) => entry.id === restaurantId),
    ))
  ) {
    throw new Error("ресторан не найден в GraphQL-списке первой страницы");
  }
  if (
    !(await everyGateway(async (base) =>
      (await nearby(base)).some((entry) => entry.id === restaurantId),
    ))
  ) {
    throw new Error("новая зона не видна в GraphQL-выдаче по адресу");
  }
  if (!expectRedisDown) {
    // Повторное чтение должно зарегистрировать попадание в кэш Gateway.
    await restaurantPage();
    const metrics = await (await fetch(new URL("/metrics", gateway))).text();
    if (
      !metrics
        .split("\n")
        .some(
          (line) =>
            line.startsWith("cache_reads_total{") &&
            line.includes('cache="listing"') &&
            line.includes('result="hit"') &&
            /\s[1-9]\d*(?:\.\d+)?$/.test(line),
        )
    ) {
      throw new Error("в /metrics нет попадания в кэш общих списков");
    }
  }

  const newName = `Обновлённая проверка ${restaurantId.slice(0, 8)}`;
  const renamed = await request(
    catalog,
    `/restaurants/${restaurantId}`,
    "PATCH",
    { name: newName },
    admin,
  );
  if (renamed.status !== 200) throw new Error(`restaurant update: ${JSON.stringify(renamed)}`);
  const restaurantChangeVisibleAfterMs = await waitUntil(
    async () =>
      everyGateway(async (base) =>
        (await restaurantPage(base)).some(
          (entry) => entry.id === restaurantId && entry.name === newName,
        ),
      ),
    "изменение ресторана не видно в GraphQL-списке за 5 секунд",
  );

  const disabledZone = await request(
    catalog,
    `/zones/${zone.result.id}`,
    "PATCH",
    { restaurantId, isActive: false },
    manager,
  );
  if (disabledZone.status !== 200) throw new Error(`zone update: ${JSON.stringify(disabledZone)}`);
  const zoneChangeVisibleAfterMs = await waitUntil(
    async () =>
      everyGateway(
        async (base) => !(await nearby(base)).some((entry) => entry.id === restaurantId),
      ),
    "отключение зоны не видно в GraphQL-выдаче за 5 секунд",
  );
  const enabledZone = await request(
    catalog,
    `/zones/${zone.result.id}`,
    "PATCH",
    { restaurantId, isActive: true },
    manager,
  );
  if (enabledZone.status !== 200) throw new Error(`zone restore: ${JSON.stringify(enabledZone)}`);
  await waitUntil(
    async () =>
      everyGateway(async (base) => (await nearby(base)).some((entry) => entry.id === restaurantId)),
    "восстановление зоны не видно в GraphQL-выдаче за 5 секунд",
  );

  const quote = await request(catalog, `/restaurants/${restaurantId}/validate-cart`, "POST", {
    latitude: 55.75,
    longitude: 37.62,
    items: [
      {
        itemId,
        quantity: 1,
        selections: [
          {
            groupId: groups.result.optionGroups[0].id,
            optionIds: [groups.result.optionGroups[0].options[0].id],
          },
        ],
      },
    ],
  });
  if (quote.status !== 201 || quote.result.total !== 35000) {
    throw new Error(`cart validation: ${JSON.stringify(quote)}`);
  }

  const wrongManager = token(["manager"], randomUUID());
  const denied = await request(
    catalog,
    `/menu/items/${itemId}/availability`,
    "PATCH",
    { restaurantId, isAvailable: false },
    wrongManager,
  );
  if (denied.status !== 403) throw new Error(`ownership check: ${JSON.stringify(denied)}`);

  if (
    !(await everyGateway(async (base) =>
      (await menu(restaurantId, base)).some(
        (entry) =>
          entry.id === itemId &&
          entry.imageUrl === "https://example.org/verification.jpg" &&
          entry.optionGroups[0]?.options[0]?.priceDelta === 5000,
      ),
    ))
  ) {
    throw new Error("изображение или модификатор блюда не дошли до GraphQL");
  }

  const load = await loadMenu(restaurantId);

  const stopped = await request(
    catalog,
    `/menu/items/${itemId}/availability`,
    "PATCH",
    { restaurantId, isAvailable: false, reason: "проверка" },
    manager,
  );
  if (stopped.status !== 200) throw new Error(`stop list: ${JSON.stringify(stopped)}`);

  const started = performance.now();
  let elapsed;
  while (performance.now() - started < 5000) {
    if (
      await everyGateway(
        async (base) => !(await menu(restaurantId, base)).some((entry) => entry.id === itemId),
      )
    ) {
      elapsed = performance.now() - started;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (elapsed === undefined) throw new Error("стоп-лист не виден через Gateway за 5 секунд");
  const restored = await request(
    catalog,
    `/menu/items/${itemId}/availability`,
    "PATCH",
    { restaurantId, isAvailable: true },
    manager,
  );
  if (restored.status !== 200) throw new Error(`restore: ${JSON.stringify(restored)}`);
  const restoredStarted = performance.now();
  while (performance.now() - restoredStarted < 5000) {
    if (
      await everyGateway(async (base) =>
        (await menu(restaurantId, base)).some((entry) => entry.id === itemId),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (
    !(await everyGateway(async (base) =>
      (await menu(restaurantId, base)).some((entry) => entry.id === itemId),
    ))
  ) {
    throw new Error("восстановленное блюдо не появилось через Gateway");
  }
  const removed = await request(
    catalog,
    `/menu/items/${itemId}?restaurantId=${restaurantId}`,
    "DELETE",
    undefined,
    manager,
  );
  if (removed.status !== 200) throw new Error(`delete: ${JSON.stringify(removed)}`);
  const deletedStarted = performance.now();
  while (performance.now() - deletedStarted < 5000) {
    if (
      await everyGateway(
        async (base) => !(await menu(restaurantId, base)).some((entry) => entry.id === itemId),
      )
    )
      break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (
    !(await everyGateway(
      async (base) => !(await menu(restaurantId, base)).some((entry) => entry.id === itemId),
    ))
  ) {
    throw new Error("удалённое блюдо осталось в GraphQL-меню");
  }
  console.log(
    JSON.stringify({
      ownershipDenied: true,
      imageVisible: true,
      modifiersVisible: true,
      cartTotal: quote.result.total,
      restaurantChangeVisibleAfterMs,
      zoneChangeVisibleAfterMs,
      stopListVisibleAfterMs: Math.round(elapsed),
      restoreVisible: true,
      deleteVisible: true,
      gatewayReplicas: gateways.length,
      redisDown: expectRedisDown,
      ...(load ? { load } : {}),
    }),
  );
} finally {
  if (restaurantId) {
    await db.connect();
    try {
      await db.query("DELETE FROM outbox_messages WHERE payload->'payload'->>'restaurantId' = $1", [
        restaurantId,
      ]);
      await db.query("DELETE FROM restaurants WHERE id = $1", [restaurantId]);
    } finally {
      await db.end();
    }
  }
}
