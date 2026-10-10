/**
 * Сквозная проверка оформления заказа через шлюз GraphQL — так, как это
 * делает витрина: gateway + catalog + order + payment + Keycloak.
 *
 *   GATEWAY_URL=http://localhost:13000 node infra/verification/checkout-e2e.mjs
 *
 * Вход — учебной учётной записью клиента из файла области Keycloak
 * (CLIENT_LOGIN / CLIENT_PASSWORD, по умолчанию client@food.local).
 *
 * Что проверяется:
 *   1. рестораны по адресу и меню; позиции набираются до минимальной суммы;
 *   2. оформление; повтор с тем же ключом — тот же заказ (ORD-4);
 *   3. шлюз подставил в заказ название ресторана из каталога;
 *   4. оплата проходит фоновым шагом саги — заказ у ресторана;
 *   5. заказ в истории клиента с признаком «можно отменить» (ORD-5, ORD-7);
 *   6. отмена; повтор отмены (двойное нажатие) — без ошибки и без второго
 *      перехода; в истории переходов — одна отмена;
 *   7. без входа заказ не отдаётся; неизвестный ресторан — null.
 */
import { randomUUID } from "node:crypto";

const gateway = new URL(process.env.GATEWAY_URL ?? "http://localhost:13000");
if (gateway.hostname !== "localhost") {
  throw new Error("проверка с учебными учётными данными допускается только на localhost");
}
const login = process.env.CLIENT_LOGIN ?? "client@food.local";
const password = process.env.CLIENT_PASSWORD ?? "client";
// Адрес-образец витрины «Арбат»
const address = { text: "Москва, Арбат, 10", latitude: 55.7495, longitude: 37.5916 };

let failures = 0;
function check(condition, message, extra) {
  if (condition) console.log(`  ✓ ${message}`);
  else {
    failures += 1;
    console.log(`  ✗ ${message}`, extra ?? "");
  }
}

async function graphql(query, variables = {}, token) {
  const response = await fetch(new URL("/graphql", gateway), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

const ORDER_FIELDS = `id orderNumber status canCancel restaurant { name } amounts { total }`;

const signIn = await fetch(new URL("/auth/login", gateway), {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ username: login, password }),
});
const { accessToken: token } = await signIn.json();
if (!token) throw new Error(`вход не удался: ${signIn.status}`);

console.log("1. Ресторан по адресу и меню");
const nearby = await graphql(
  `
    query ($lat: Float!, $lon: Float!) {
      restaurantsNearby(latitude: $lat, longitude: $lon) {
        id
        name
        minOrderAmount
      }
    }
  `,
  { lat: address.latitude, lon: address.longitude },
);
const restaurants = nearby.data?.restaurantsNearby ?? [];
check(restaurants.length > 0, `по адресу доставляют: ${restaurants.length}`);

let restaurant;
let items = [];
for (const candidate of restaurants) {
  const menu = await graphql(
    `
      query ($id: ID!) {
        menu(restaurantId: $id, includeUnavailable: false) {
          categories {
            items {
              id
              price
              optionGroups {
                id
              }
            }
          }
        }
      }
    `,
    { id: candidate.id },
  );
  const simple = (menu.data?.menu.categories ?? [])
    .flatMap((category) => category.items)
    .filter((item) => item.optionGroups.length === 0);
  let sum = 0;
  const chosen = [];
  for (const item of simple) {
    if (sum >= candidate.minOrderAmount) break;
    chosen.push(item);
    sum += item.price;
  }
  if (sum >= candidate.minOrderAmount) {
    restaurant = candidate;
    items = chosen.map((item) => ({ itemId: item.id, quantity: 1 }));
    break;
  }
}
check(!!restaurant, `выбран «${restaurant?.name}», позиций: ${items.length}`);

console.log("2. Оформление и повтор с тем же ключом (ORD-4)");
const PLACE = `mutation($input: PlaceOrderInput!) { placeOrder(input: $input) { replayed order { ${ORDER_FIELDS} } } }`;
const input = {
  restaurantId: restaurant.id,
  idempotencyKey: randomUUID(),
  address,
  contactPhone: "+7 900 000-00-00",
  comment: "сквозная проверка",
  items,
};
const placed = await graphql(PLACE, { input }, token);
const order = placed.data?.placeOrder.order;
check(
  order && placed.data.placeOrder.replayed === false,
  `заказ №${order?.orderNumber} оформлен`,
  placed.errors,
);
const again = await graphql(PLACE, { input }, token);
check(
  again.data?.placeOrder.replayed === true && again.data.placeOrder.order.id === order?.id,
  "повтор вернул тот же заказ, второй не создан",
  again.errors,
);

console.log("3. Склейка ответов сервисов в шлюзе");
check(
  order?.restaurant?.name === restaurant.name,
  `в заказе название ресторана: «${order?.restaurant?.name}»`,
);

console.log("4. Оплата фоновым шагом саги");
const ORDER = `query($id: ID!) { order(id: $id) { ${ORDER_FIELDS} } orderTransitions(id: $id) { to } }`;
let current;
for (let attempt = 0; attempt < 40; attempt += 1) {
  current = await graphql(ORDER, { id: order.id }, token);
  if (current.data?.order.status === "AWAITING_RESTAURANT") break;
  await new Promise((resolve) => setTimeout(resolve, 250));
}
check(current.data?.order.status === "AWAITING_RESTAURANT", "оплата прошла, заказ ждёт ресторан");

console.log("5. История клиента (ORD-7)");
const mine = await graphql(
  `query { myOrders(limit: 5, offset: 0) { ${ORDER_FIELDS} } }`,
  {},
  token,
);
const listed = mine.data?.myOrders.find((candidate) => candidate.id === order.id);
check(!!listed, "заказ в истории клиента");
check(listed?.canCancel === true, "до подтверждения рестораном отменить можно (ORD-5)");

console.log("6. Отмена клиентом");
const CANCEL = `mutation($id: ID!) { cancelOrder(id: $id) { ${ORDER_FIELDS} } }`;
const cancelled = await graphql(CANCEL, { id: order.id }, token);
check(
  cancelled.data?.cancelOrder.status === "CANCELLED" &&
    cancelled.data.cancelOrder.canCancel === false,
  "заказ отменён, отменять больше нечего",
  cancelled.errors,
);
const twice = await graphql(CANCEL, { id: order.id }, token);
check(
  !twice.errors && twice.data?.cancelOrder.status === "CANCELLED",
  "повтор отмены — тот же отменённый заказ, без ошибки",
  twice.errors,
);
const history = await graphql(ORDER, { id: order.id }, token);
check(
  history.data?.orderTransitions.at(-1)?.to === "CANCELLED" &&
    history.data.orderTransitions.filter((t) => t.to === "CANCELLED").length === 1,
  "в истории переходов одна отмена, и она последняя",
);

console.log("7. Доступ");
const anonymous = await graphql(ORDER, { id: order.id });
check(anonymous.errors?.[0]?.extensions?.code === "UNAUTHORIZED", "без входа заказ не отдаётся");
const unknown = await graphql(
  `
    query ($id: ID!) {
      restaurant(id: $id) {
        id
      }
    }
  `,
  { id: randomUUID() },
);
check(unknown.data?.restaurant === null, "неизвестный ресторан — null, а не ошибка");

console.log(failures === 0 ? "\nВсе проверки пройдены" : `\nНе пройдено проверок: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
