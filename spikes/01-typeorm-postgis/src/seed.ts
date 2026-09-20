import type { DataSource } from "typeorm";
import { Courier, DeliveryZone, Restaurant, type GeoPolygon } from "./entities.js";

/** Границы Москвы в пределах МКАД — приблизительно. */
const LON_MIN = 37.37;
const LON_MAX = 37.85;
const LAT_MIN = 55.58;
const LAT_MAX = 55.91;

const rnd = (min: number, max: number) => min + Math.random() * (max - min);

/** Квадратная зона доставки со стороной ~2*radius вокруг точки ресторана. */
function squareZone(lon: number, lat: number, radiusDeg: number): GeoPolygon {
  const ring: [number, number][] = [
    [lon - radiusDeg, lat - radiusDeg],
    [lon + radiusDeg, lat - radiusDeg],
    [lon + radiusDeg, lat + radiusDeg],
    [lon - radiusDeg, lat + radiusDeg],
    [lon - radiusDeg, lat - radiusDeg],
  ];
  return { type: "Polygon", coordinates: [ring] };
}

export async function seed(ds: DataSource, restaurantCount = 500, courierCount = 200) {
  const restaurants: Restaurant[] = [];
  const zones: DeliveryZone[] = [];

  for (let i = 0; i < restaurantCount; i++) {
    const lon = rnd(LON_MIN, LON_MAX);
    const lat = rnd(LAT_MIN, LAT_MAX);

    const r = new Restaurant();
    r.name = `Ресторан №${i + 1}`;
    r.location = { type: "Point", coordinates: [lon, lat] };
    restaurants.push(r);
  }
  const savedRestaurants = await ds.getRepository(Restaurant).save(restaurants, { chunk: 100 });

  for (const r of savedRestaurants) {
    const [lon, lat] = r.location!.coordinates;
    const z = new DeliveryZone();
    z.restaurantId = r.id;
    // ~0.02 градуса ≈ 2,2 км по широте — правдоподобный радиус доставки
    z.area = squareZone(lon, lat, rnd(0.012, 0.03));
    z.deliveryFee = String(Math.round(rnd(99, 349)));
    zones.push(z);
  }
  await ds.getRepository(DeliveryZone).save(zones, { chunk: 100 });

  const couriers: Courier[] = [];
  for (let i = 0; i < courierCount; i++) {
    const c = new Courier();
    c.name = `Курьер №${i + 1}`;
    c.status = Math.random() < 0.6 ? "available" : "busy";
    c.lastLocation = {
      type: "Point",
      coordinates: [rnd(LON_MIN, LON_MAX), rnd(LAT_MIN, LAT_MAX)],
    };
    couriers.push(c);
  }
  await ds.getRepository(Courier).save(couriers, { chunk: 100 });

  return {
    restaurants: savedRestaurants.length,
    zones: zones.length,
    couriers: couriers.length,
  };
}
