/* global __ENV:readonly */
import http from "k6/http";
import { check, fail, sleep } from "k6";
import exec from "k6/execution";
import { Rate } from "k6/metrics";

const gateway = "http://proxy:8080";
const profile = __ENV.LOAD_PROFILE || "peak";
const shapes = {
  smoke: { ramp: "10s", hold: "20s", browse: [5, 25], orders: [5, 15] },
  sample: { ramp: "20s", hold: "1m", browse: [50, 250], orders: [20, 60] },
  peak: { ramp: "10m", hold: "20m", browse: [50, 250], orders: [20, 60] },
};
if (!shapes[profile]) throw new Error("LOAD_PROFILE: smoke, sample или peak");

const shape = shapes[profile];
const catalogOk = new Rate("catalog_ok");
const checkoutOk = new Rate("checkout_ok");
const cancelOk = new Rate("cancel_ok");

function arrivalRate(rates, unit, vus, maxVUs, action) {
  return {
    executor: "ramping-arrival-rate",
    startRate: rates[0],
    timeUnit: unit,
    stages: [
      { target: rates[1], duration: shape.ramp },
      { target: rates[1], duration: shape.hold },
    ],
    preAllocatedVUs: vus,
    maxVUs,
    exec: action,
  };
}

export const options = {
  discardResponseBodies: true,
  scenarios: {
    catalog: arrivalRate(shape.browse, "1s", profile === "smoke" ? 10 : 80, 200, "browse"),
    checkout: arrivalRate(shape.orders, "1m", 3, 8, "checkout"),
  },
  thresholds: {
    "http_req_duration{name:catalog}": ["p(95)<=300"],
    "http_req_duration{name:checkout}": ["p(95)<=800"],
    catalog_ok: ["rate>=0.99"],
    checkout_ok: ["rate>=0.99"],
    cancel_ok: ["rate>=0.99"],
    dropped_iterations: ["count==0"],
  },
};

const points = [
  { text: "Москва, Тверская", latitude: 55.7615, longitude: 37.6094 },
  { text: "Москва, Арбат", latitude: 55.7495, longitude: 37.5916 },
  { text: "Москва, Парк Горького", latitude: 55.7294, longitude: 37.6036 },
];

const nearby =
  "query ($lat: Float!, $lon: Float!) { restaurantsNearby(latitude: $lat, longitude: $lon) { id name minOrderAmount } }";
const menu =
  "query ($id: ID!) { menu(restaurantId: $id, includeUnavailable: false) { categories { items { id price optionGroups { id } } } } }";
const place = "mutation ($input: PlaceOrderInput!) { placeOrder(input: $input) { order { id } } }";
const cancel =
  'mutation ($id: ID!) { cancelOrder(id: $id, reason: "Нагрузочный тест") { status } }';

function json(response) {
  try {
    return response.json();
  } catch {
    return null;
  }
}

function graphql(name, query, variables, token) {
  const response = http.post(`${gateway}/graphql`, JSON.stringify({ query, variables }), {
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    tags: { name },
    responseType: "text",
    timeout: "5s",
  });
  return response.status === 200 ? json(response) : null;
}

function restaurantsAt(address, name) {
  const response = graphql(name, nearby, { lat: address.latitude, lon: address.longitude });
  return response?.data?.restaurantsNearby;
}

export function setup() {
  let available = false;
  for (let attempt = 0; attempt < 20 && !available; attempt += 1) {
    available = Array.isArray(restaurantsAt(points[0], "setup"));
    if (!available) sleep(1);
  }
  if (!available) fail("Прокси не вышел на готовые реплики шлюза");
  for (const address of points) {
    for (const restaurant of restaurantsAt(address, "setup") || []) {
      const categories = graphql("setup", menu, { id: restaurant.id })?.data?.menu?.categories;
      if (!categories) continue;
      const items = [];
      let sum = 0;
      for (const category of categories) {
        for (const item of category.items) {
          if (item.optionGroups.length || sum >= restaurant.minOrderAmount) continue;
          items.push({ itemId: item.id, quantity: 1 });
          sum += item.price;
        }
      }
      if (items.length && sum >= restaurant.minOrderAmount) {
        return { address, restaurantId: restaurant.id, items, runId: String(Date.now()) };
      }
    }
  }
  fail("На тестовом стенде нет ресторана с меню для нагрузки");
}

export function browse() {
  const point = points[exec.scenario.iterationInTest % points.length];
  const found = restaurantsAt(point, "catalog");
  catalogOk.add(check(found, { "каталог ответил": (list) => Array.isArray(list) }));
}

let token;
let renewAt = 0;
function accessToken() {
  if (Date.now() < renewAt) return token;
  const response = http.post(
    `${gateway}/auth/login`,
    JSON.stringify({
      username: __ENV.LOAD_CLIENT_LOGIN || "client@food.local",
      password: __ENV.LOAD_CLIENT_PASSWORD || "client",
    }),
    {
      headers: { "Content-Type": "application/json" },
      tags: { name: "login" },
      responseType: "text",
      timeout: "5s",
    },
  );
  const session = response.status === 200 ? json(response) : null;
  token = session?.accessToken;
  renewAt = Date.now() + (token ? Math.max(1, session.expiresIn - 60) * 1000 : 10_000);
  return token;
}

export function checkout(fixture) {
  const auth = accessToken();
  const order = auth
    ? graphql(
        "checkout",
        place,
        {
          input: {
            restaurantId: fixture.restaurantId,
            idempotencyKey: `k6-${fixture.runId}-${exec.scenario.iterationInTest}`,
            address: fixture.address,
            contactPhone: "+7 900 000-00-00",
            items: fixture.items,
          },
        },
        auth,
      )?.data?.placeOrder?.order
    : null;
  checkoutOk.add(check(order, { "заказ оформлен": (value) => Boolean(value?.id) }));
  if (!order?.id) return;
  const result = graphql("cancel", cancel, { id: order.id }, auth);
  cancelOk.add(
    check(result, {
      "тестовый заказ отменён": (body) => body?.data?.cancelOrder?.status === "CANCELLED",
    }),
  );
}
