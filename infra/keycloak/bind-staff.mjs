/**
 * Привязка учётных записей сотрудников к ресторану.
 *
 * Зачем нужен отдельный шаг. Роль менеджера отвечает на вопрос «имеет ли
 * право вообще», а привязка к ресторану — «на какой именно ресторан»
 * (требование SEC-2). Идентификаторы ресторанов создаёт наполнитель данных,
 * и заранее, в файле области Keycloak, их знать невозможно: при каждом
 * наполнении они новые.
 *
 * Поэтому после `npm run db:seed` запускается этот сценарий: он находит
 * первый действующий ресторан и записывает его идентификатор в учётные
 * записи менеджера и кухни.
 *
 * Запуск: npm run auth:bind
 */
import pg from "pg";

const KEYCLOAK = process.env.KEYCLOAK_URL ?? "http://localhost:18080";
const REALM = process.env.KEYCLOAK_REALM ?? "food-delivery";
const ADMIN = process.env.KEYCLOAK_ADMIN ?? "admin";
const ADMIN_PASSWORD = process.env.KEYCLOAK_ADMIN_PASSWORD ?? "admin";

/** Кого привязываем. Курьер, оператор и администратор к ресторану не относятся. */
const STAFF = ["manager@food.local", "kitchen@food.local"];

const db = {
  host: process.env.POSTGRES_HOST ?? "localhost",
  port: Number(process.env.POSTGRES_PORT ?? 15432),
  user: process.env.POSTGRES_USER ?? "app",
  password: process.env.POSTGRES_PASSWORD ?? "app",
  database: process.env.CATALOG_DB ?? "catalog_db",
};

async function adminToken() {
  const response = await fetch(`${KEYCLOAK}/realms/master/protocol/openid-connect/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "password",
      client_id: "admin-cli",
      username: ADMIN,
      password: ADMIN_PASSWORD,
    }),
  });

  if (!response.ok) {
    throw new Error(`не удалось войти в Keycloak как администратор: ${response.status}`);
  }

  return (await response.json()).access_token;
}

async function findRestaurant() {
  const client = new pg.Client(db);
  await client.connect();

  try {
    const { rows } = await client.query(
      `SELECT id, name FROM restaurants WHERE is_active ORDER BY name LIMIT 1`,
    );
    if (rows.length === 0) {
      throw new Error("в базе нет ни одного действующего ресторана: сначала npm run db:seed");
    }
    return rows[0];
  } finally {
    await client.end();
  }
}

async function bind(token, email, restaurantId) {
  const search = await fetch(
    `${KEYCLOAK}/admin/realms/${REALM}/users?email=${encodeURIComponent(email)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const [user] = await search.json();

  if (!user) {
    console.log(`  ${email}: учётная запись не найдена — пропускаю`);
    return;
  }

  const response = await fetch(`${KEYCLOAK}/admin/realms/${REALM}/users/${user.id}`, {
    method: "PUT",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    // Свойства пользователя передаются целиком: частичное обновление
    // в этом интерфейсе стирает не переданные поля.
    body: JSON.stringify({
      ...user,
      attributes: { ...(user.attributes ?? {}), restaurantId: [restaurantId] },
    }),
  });

  if (!response.ok) {
    throw new Error(`${email}: не удалось записать привязку (${response.status})`);
  }

  console.log(`  ${email} → ресторан ${restaurantId}`);
}

/**
 * Курьер из файла области привязывается к курьеру в базе доставки: курьер
 * действует от своей учётной записи, и без привязки на смену не выйти.
 */
async function bindCourier(token) {
  const search = await fetch(
    `${KEYCLOAK}/admin/realms/${REALM}/users?email=${encodeURIComponent(COURIER)}&exact=true`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  const [user] = await search.json();
  if (!user) {
    console.log(`  ${COURIER}: учётная запись не найдена — пропускаю`);
    return;
  }

  const client = new pg.Client({ ...db, database: process.env.DELIVERY_DB ?? "delivery_db" });
  await client.connect();
  try {
    // Учётная запись может быть уже привязана к другому курьеру — отвязываем.
    await client.query(`UPDATE couriers SET user_id = NULL WHERE user_id = $1`, [user.id]);
    const { rows } = await client.query(
      `UPDATE couriers SET user_id = $1, status = 'offline', current_delivery_id = NULL
        WHERE id = (SELECT id FROM couriers WHERE is_active ORDER BY full_name LIMIT 1)
        RETURNING full_name`,
      [user.id],
    );
    if (rows.length === 0) {
      console.log("  в базе доставки нет курьеров: сначала npm run db:seed");
      return;
    }
    console.log(`  ${COURIER} → курьер «${rows[0].full_name}»`);
  } finally {
    await client.end();
  }
}

const COURIER = "courier@food.local";

const restaurant = await findRestaurant();
console.log(`Привязка сотрудников к ресторану «${restaurant.name}»`);

const token = await adminToken();
for (const email of STAFF) {
  await bind(token, email, restaurant.id);
}
await bindCourier(token);

console.log("\nГотово. Токен сотрудника теперь содержит поле restaurantId,");
console.log("и сервис проверяет по нему владение рестораном (SEC-2).");
