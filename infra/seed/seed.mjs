/**
 * Генератор тестовых данных.
 *
 * Реальных данных о ресторанах и заказах у проекта нет — это записано
 * в ограничениях. Чтобы замеры имели смысл, данные должны быть
 * правдоподобными по объёму и по распределению: точки разбросаны
 * по городу, зоны доставки перекрываются, часть блюд в стоп-листе.
 *
 * Запуск: npm run db:seed
 * Повторный запуск очищает прежние данные — результат воспроизводим.
 */
import pg from "pg";

const CONNECTION = {
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER ?? "app",
  password: process.env.POSTGRES_PASSWORD ?? "app",
};

const RESTAURANTS = Number(process.env.SEED_RESTAURANTS ?? 50);
const COURIERS = Number(process.env.SEED_COURIERS ?? 20);

/**
 * Точки не разбрасываются равномерно по городу: и заведения, и курьеры
 * сосредоточены в нескольких оживлённых районах. Равномерный разброс
 * по площади Москвы даёт плотность около одного объекта на 50 км², и тогда
 * запросы «рестораны рядом» и «курьеры в радиусе 3 км» ничего не находят —
 * данные оказываются непригодны для проверки.
 */
const DISTRICTS = [
  { name: "Центр", lon: 37.6176, lat: 55.7558, weight: 0.3 },
  { name: "Арбат", lon: 37.5896, lat: 55.7494, weight: 0.15 },
  { name: "Сокольники", lon: 37.6796, lat: 55.7894, weight: 0.15 },
  { name: "Хамовники", lon: 37.5776, lat: 55.7275, weight: 0.15 },
  { name: "Таганка", lon: 37.6533, lat: 55.7403, weight: 0.15 },
  { name: "Ленинский", lon: 37.5735, lat: 55.7005, weight: 0.1 },
];

const rnd = (a, b) => a + Math.random() * (b - a);

/** Точка внутри района: нормальное рассеяние радиусом около 1,5 км. */
function pointInCity() {
  let roll = Math.random();
  let district = DISTRICTS[DISTRICTS.length - 1];
  for (const candidate of DISTRICTS) {
    if (roll < candidate.weight) {
      district = candidate;
      break;
    }
    roll -= candidate.weight;
  }
  const spread = 0.014; // около 1,5 км
  return [
    district.lon + (Math.random() + Math.random() - 1) * spread,
    district.lat + (Math.random() + Math.random() - 1) * spread * 0.6,
  ];
}
const pick = (list) => list[Math.floor(Math.random() * list.length)];
const int = (a, b) => Math.floor(rnd(a, b + 1));

const CUISINES = [
  ["Пицца", ["Маргарита", "Пепперони", "Четыре сыра", "Барбекю", "Вегетарианская", "Карбонара"]],
  ["Суши и роллы", ["Филадельфия", "Калифорния", "Дракон", "Запечённый с лососем", "Унаги"]],
  ["Бургеры", ["Чизбургер", "Двойной бекон", "Куриный", "Вегетарианский", "Острый"]],
  ["Паста", ["Болоньезе", "Карбонара", "Четыре сыра", "Песто", "Морепродукты"]],
  ["Супы", ["Борщ", "Том ям", "Куриный", "Грибной крем-суп", "Харчо"]],
  ["Салаты", ["Цезарь", "Греческий", "Оливье", "Тёплый с говядиной"]],
  ["Напитки", ["Морс", "Лимонад", "Americano", "Капучино", "Зелёный чай"]],
  ["Десерты", ["Чизкейк", "Тирамису", "Панна-котта", "Медовик"]],
];

/** Состав зависит от категории: иначе поиск по составу находит всё подряд. */
const COMPOSITION = {
  Пицца: "тесто, моцарелла, томатный соус, орегано",
  "Суши и роллы": "рис, нори, лосось, сливочный сыр, огурец",
  Бургеры: "булочка, котлета, салат, томат, соус",
  Паста: "спагетти, сливки, пармезан, чеснок",
  Супы: "бульон, овощи, зелень, специи",
  Салаты: "листья салата, овощи, оливковое масло",
  Напитки: "вода, сахар, натуральный сок",
  Десерты: "сливочный сыр, сахар, ваниль, ягоды",
};

const PREFIX = ["Вкусно", "Дом", "Мама", "Тепло", "Сытый", "Золотой", "Старый", "Новый"];
const SUFFIX = ["Кухня", "Дворик", "Печь", "Обед", "Пир", "Стол", "Погреб", "Сад"];

async function seedCatalog(client) {
  await client.query(`TRUNCATE restaurants CASCADE`);

  let items = 0;
  let stopped = 0;

  for (let i = 0; i < RESTAURANTS; i++) {
    const [lon, lat] = pointInCity();
    const name = `${pick(PREFIX)} ${pick(SUFFIX)} №${i + 1}`;

    const {
      rows: [restaurant],
    } = await client.query(
      `INSERT INTO restaurants
         (name, description, phone, address_text, location,
          min_order_amount, delivery_fee_base, avg_cooking_time_min, is_active)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
               $7, $8, $9, $10)
       RETURNING id`,
      [
        name,
        "Доставка готовых блюд",
        `+7495${int(1000000, 9999999)}`,
        `ул. Примерная, д. ${int(1, 120)}`,
        lon,
        lat,
        int(3, 12) * 10000, // минимальная сумма 300–1200 рублей
        int(0, 4) * 4900, // доставка 0–196 рублей
        int(15, 60),
        // каждый десятый ресторан отключён — чтобы фильтр выдачи было на чём проверить
        i % 10 !== 9,
      ],
    );

    // Зона доставки: прямоугольник вокруг ресторана радиусом 1,3–3,3 км.
    // Зоны намеренно перекрываются — по одному адресу должно находиться
    // несколько ресторанов, иначе запрос CAT-1 нечего проверять.
    const r = rnd(0.012, 0.03);
    await client.query(
      `INSERT INTO delivery_zones (restaurant_id, area, delivery_fee, min_order_amount)
       VALUES ($1, ST_Multi(ST_MakeEnvelope($2, $3, $4, $5, 4326))::geography, $6, $7)`,
      [restaurant.id, lon - r, lat - r, lon + r, lat + r, int(0, 4) * 4900, int(3, 12) * 10000],
    );

    // Расписание: будни 10:00–23:00, выходные 11:00–00:00
    for (let day = 0; day < 7; day++) {
      await client.query(
        `INSERT INTO restaurant_schedules (restaurant_id, day_of_week, opens_at, closes_at)
         VALUES ($1, $2, $3, $4)`,
        [restaurant.id, day, day < 5 ? "10:00" : "11:00", day < 5 ? "23:00" : "23:59"],
      );
    }

    // Меню: 3–5 категорий, в каждой 5–10 блюд
    const categories = [...CUISINES].sort(() => Math.random() - 0.5).slice(0, int(3, 5));

    for (const [categoryIndex, [categoryName, dishes]] of categories.entries()) {
      const {
        rows: [category],
      } = await client.query(
        `INSERT INTO menu_categories (restaurant_id, name, sort_order)
         VALUES ($1, $2, $3) RETURNING id`,
        [restaurant.id, categoryName, categoryIndex],
      );

      const count = int(5, 10);
      for (let d = 0; d < count; d++) {
        const dishName = `${pick(dishes)} ${d > dishes.length - 1 ? "особый" : ""}`.trim();
        // Каждое двадцатое блюдо — в стоп-листе
        const available = Math.random() > 0.05;
        if (!available) stopped++;

        const {
          rows: [item],
        } = await client.query(
          `INSERT INTO menu_items
             (restaurant_id, category_id, name, description, composition,
              price, weight_grams, calories, is_available, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
          [
            restaurant.id,
            category.id,
            dishName,
            "Готовится по фирменному рецепту",
            COMPOSITION[categoryName] ?? "натуральные ингредиенты",
            int(15, 90) * 1000, // 150–900 рублей
            int(150, 600),
            int(200, 900),
            available,
            d,
          ],
        );
        items++;

        if (!available) {
          await client.query(
            `INSERT INTO stop_list_entries (menu_item_id, reason) VALUES ($1, $2)`,
            [item.id, "закончились ингредиенты"],
          );
        }

        // Модификаторы примерно у половины блюд
        if (Math.random() < 0.5) {
          const {
            rows: [group],
          } = await client.query(
            `INSERT INTO item_option_groups
               (menu_item_id, name, selection_type, is_required, min_select, max_select)
             VALUES ($1, 'Размер', 'single', TRUE, 1, 1) RETURNING id`,
            [item.id],
          );
          for (const [optionName, delta] of [
            ["Маленький", -5000],
            ["Средний", 0],
            ["Большой", 9000],
          ]) {
            await client.query(
              `INSERT INTO item_options (group_id, name, price_delta) VALUES ($1, $2, $3)`,
              [group.id, optionName, delta],
            );
          }

          const {
            rows: [extras],
          } = await client.query(
            `INSERT INTO item_option_groups
               (menu_item_id, name, selection_type, is_required, min_select, max_select, sort_order)
             VALUES ($1, 'Добавки', 'multiple', FALSE, 0, 5, 1) RETURNING id`,
            [item.id],
          );
          for (const [optionName, delta] of [
            ["Дополнительный сыр", 6000],
            ["Острый соус", 3000],
            ["Бекон", 8000],
          ]) {
            await client.query(
              `INSERT INTO item_options (group_id, name, price_delta) VALUES ($1, $2, $3)`,
              [extras.id, optionName, delta],
            );
          }
        }
      }
    }
  }

  await client.query("ANALYZE");
  return { items, stopped };
}

async function seedDelivery(client) {
  await client.query(`TRUNCATE couriers CASCADE`);

  for (let i = 0; i < COURIERS; i++) {
    const [courierLon, courierLat] = pointInCity();
    await client.query(
      `INSERT INTO couriers (full_name, phone, vehicle_type, status, last_location, last_location_at, rating)
       VALUES ($1, $2, $3, $4, ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography, now(), $7)`,
      [
        `Курьер №${i + 1}`,
        `+7916${int(1000000, 9999999)}`,
        pick(["foot", "bike", "car"]),
        // 60 % свободны, остальные заняты или не на смене
        Math.random() < 0.6 ? "available" : pick(["busy", "offline"]),
        courierLon,
        courierLat,
        (Math.random() * 1.5 + 3.5).toFixed(2),
      ],
    );
  }

  await client.query("ANALYZE");
}

async function main() {
  console.log(`Наполнение тестовыми данными (${CONNECTION.host}:${CONNECTION.port})`);

  const catalog = new pg.Client({
    ...CONNECTION,
    database: process.env.CATALOG_DB ?? "catalog_db",
  });
  await catalog.connect();
  const stats = await seedCatalog(catalog);
  await catalog.end();
  console.log(
    `  каталог: ${RESTAURANTS} ресторанов, ${stats.items} блюд ` +
      `(${stats.stopped} в стоп-листе), зоны доставки и расписание`,
  );

  const delivery = new pg.Client({
    ...CONNECTION,
    database: process.env.DELIVERY_DB ?? "delivery_db",
  });
  await delivery.connect();
  await seedDelivery(delivery);
  await delivery.end();
  console.log(`  доставка: ${COURIERS} курьеров`);

  console.log("\nГотово.");
}

main().catch((error) => {
  console.error("\nОШИБКА:", error.message);
  process.exitCode = 1;
});
