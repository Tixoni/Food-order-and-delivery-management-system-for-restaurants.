import type { DomainEvent } from "@food-delivery/shared";
import type { Coordinates } from "../../domain/coordinates";
import { DeliveryZone } from "../../domain/delivery-zone";
import { MenuCategory, type MenuSection } from "../../domain/menu-category";
import { MenuItem } from "../../domain/menu-item";
import { ItemOption, OptionGroup } from "../../domain/option-group";
import { Restaurant } from "../../domain/restaurant";
import type { MenuCache } from "../ports/menu-cache";
import type { MenuRepository } from "../ports/menu.repository";
import type { RestaurantRepository } from "../ports/restaurant.repository";
import type { AvailabilityChange, StopListRepository } from "../ports/stop-list.repository";
import type { DeliveryOffer, DeliveryZoneRepository } from "../ports/delivery-zone.repository";
import type { StopListEntry } from "../../domain/stop-list";

/**
 * Заглушки портов для тестов сценариев.
 *
 * Ровно то, ради чего вводились порты: сценарии проверяются без базы,
 * брокера, кэша и сети — за миллисекунды. Вынесены в отдельный файл,
 * потому что нужны нескольким наборам тестов; под измерение покрытия
 * этот файл не подпадает (см. jest.config.js).
 */

export class InMemoryMenuRepository implements MenuRepository {
  /** Всё, что сценарии отправили в брокер: тест проверяет события по этому списку. */
  readonly published: DomainEvent[] = [];

  constructor(
    public categories: MenuCategory[] = [],
    public items: MenuItem[] = [],
  ) {}

  async findCategories(restaurantId: string) {
    return this.categories.filter((c) => c.restaurantId === restaurantId);
  }

  async findItems(restaurantId: string, options?: { includeUnavailable?: boolean }) {
    return this.items.filter(
      (i) =>
        i.restaurantId === restaurantId &&
        !i.isDeleted &&
        (options?.includeUnavailable || i.isAvailable),
    );
  }

  async findItemById(itemId: string) {
    return this.items.find((i) => i.id === itemId && !i.isDeleted) ?? null;
  }

  async saveItem(item: MenuItem, events: DomainEvent[] = []) {
    const index = this.items.findIndex((i) => i.id === item.id);
    if (index >= 0) this.items[index] = item;
    else this.items.push(item);
    this.published.push(...events);
  }

  async saveCategory(category: MenuCategory) {
    const index = this.categories.findIndex((c) => c.id === category.id);
    if (index >= 0) this.categories[index] = category;
    else this.categories.push(category);
  }

  async categoryExists(categoryId: string, restaurantId: string) {
    return this.categories.some((c) => c.id === categoryId && c.restaurantId === restaurantId);
  }
}

export class InMemoryRestaurantRepository implements RestaurantRepository {
  readonly published: DomainEvent[] = [];
  constructor(public items: Restaurant[] = []) {}

  async save(restaurant: Restaurant, events: readonly DomainEvent[] = []) {
    const index = this.items.findIndex((r) => r.id === restaurant.id);
    if (index >= 0) this.items[index] = restaurant;
    else this.items.push(restaurant);
    this.published.push(...events);
  }

  async findActive(limit: number, offset: number) {
    return this.items.filter((r) => r.isActive).slice(offset, offset + limit);
  }

  async findById(id: string) {
    return this.items.find((r) => r.id === id) ?? null;
  }

  async countActive() {
    return this.items.filter((r) => r.isActive).length;
  }
}

/**
 * Хранилище стоп-листа вместе с блюдами: commit обязан менять признак
 * доступности, журнал и события неразрывно, и заглушка повторяет это
 * свойство — иначе тест не заметил бы нарушения атомарности.
 */
export class InMemoryStopListRepository implements StopListRepository {
  readonly entries: StopListEntry[] = [];
  readonly published: DomainEvent[] = [];
  /** Сколько раз выполнялась транзакция: проверка отсутствия лишних записей. */
  commits = 0;

  constructor(private readonly menu: InMemoryMenuRepository) {}

  async findActiveEntry(menuItemId: string) {
    return this.entries.find((e) => e.menuItemId === menuItemId && e.isActive) ?? null;
  }

  async commit(change: AvailabilityChange) {
    this.commits += 1;

    const index = this.entries.findIndex((e) => e.id === change.entry.id);
    if (index >= 0) this.entries[index] = change.entry;
    else this.entries.push(change.entry);

    await this.menu.saveItem(change.item);
    this.published.push(...change.events);
  }

  async findHistory(restaurantId: string, limit: number) {
    const itemIds = new Set(
      this.menu.items.filter((i) => i.restaurantId === restaurantId).map((i) => i.id),
    );

    return this.entries
      .filter((e) => itemIds.has(e.menuItemId))
      .sort((a, b) => b.stoppedAt.getTime() - a.stoppedAt.getTime())
      .slice(0, limit);
  }
}

export class InMemoryMenuCache implements MenuCache {
  readonly store = new Map<string, MenuSection[]>();
  reads = 0;
  writes = 0;
  invalidations = 0;

  private key(restaurantId: string, includeUnavailable: boolean) {
    return `${restaurantId}:${includeUnavailable ? "all" : "available"}`;
  }

  async read(restaurantId: string, includeUnavailable: boolean) {
    this.reads += 1;
    return this.store.get(this.key(restaurantId, includeUnavailable)) ?? null;
  }

  async write(restaurantId: string, includeUnavailable: boolean, sections: MenuSection[]) {
    this.writes += 1;
    this.store.set(this.key(restaurantId, includeUnavailable), sections);
  }

  async invalidate(restaurantId: string) {
    this.invalidations += 1;
    for (const key of [...this.store.keys()]) {
      if (key.startsWith(`${restaurantId}:`)) this.store.delete(key);
    }
  }
}

/* ─────────────── Построители доменных объектов для тестов ─────────────── */

export const restaurant = (id = "r-1") =>
  Restaurant.create({
    id,
    name: `Ресторан ${id}`,
    minOrderAmount: 50000,
    deliveryFeeBase: 14900,
    avgCookingTimeMin: 25,
    isActive: true,
  });

export const category = (id: string, name: string, sortOrder = 0, restaurantId = "r-1") =>
  MenuCategory.create({ id, restaurantId, name, sortOrder, isActive: true });

export const sizeGroup = () =>
  OptionGroup.create({
    id: "g-size",
    name: "Размер",
    selectionType: "single",
    isRequired: true,
    minSelect: 1,
    maxSelect: 1,
    options: [
      ItemOption.create({ id: "o-medium", name: "Средний", priceDelta: 0, isAvailable: true }),
      ItemOption.create({ id: "o-large", name: "Большой", priceDelta: 9000, isAvailable: true }),
    ],
  });

export const item = (
  id: string,
  categoryId: string,
  name: string,
  overrides: Partial<Parameters<typeof MenuItem.create>[0]> = {},
) =>
  MenuItem.create({
    id,
    restaurantId: "r-1",
    categoryId,
    name,
    price: 39000,
    isAvailable: true,
    sortOrder: 0,
    ...overrides,
  });

/**
 * Хранилище зон доставки в памяти.
 *
 * Вхождение точки в контур считается здесь простым перебором рёбер —
 * это заглушка для проверки сценариев, а не замена пространственному
 * запросу базы. Настоящий отбор выполняет PostGIS по индексу, и его
 * правильность проверяется на живой базе (см. замер PERF-5).
 */
export class InMemoryDeliveryZoneRepository implements DeliveryZoneRepository {
  readonly published: DomainEvent[] = [];
  constructor(
    public zones: DeliveryZone[] = [],
    private readonly restaurants: InMemoryRestaurantRepository = new InMemoryRestaurantRepository(),
  ) {}

  async findOfferForRestaurant(
    point: Coordinates,
    restaurantId: string,
  ): Promise<DeliveryOffer | null> {
    const offers = await this.findRestaurantsDeliveringTo(point, Number.MAX_SAFE_INTEGER);
    return offers.find((offer) => offer.restaurant.id === restaurantId) ?? null;
  }

  async findRestaurantsDeliveringTo(point: Coordinates, limit: number): Promise<DeliveryOffer[]> {
    const offers: DeliveryOffer[] = [];

    for (const zone of this.zones) {
      if (!zone.isActive || !contains(zone, point)) continue;

      const restaurant = await this.restaurants.findById(zone.restaurantId);
      if (!restaurant?.isActive) continue;

      offers.push({
        restaurant,
        zoneId: zone.id,
        zoneName: zone.name,
        deliveryFee: zone.deliveryFee,
        minOrderAmount: zone.minOrderAmount,
      });
    }

    return offers
      .sort(
        (a, b) =>
          a.deliveryFee - b.deliveryFee || a.restaurant.name.localeCompare(b.restaurant.name, "ru"),
      )
      .slice(0, limit);
  }

  async findByRestaurant(restaurantId: string) {
    return this.zones.filter((zone) => zone.restaurantId === restaurantId);
  }

  async findById(zoneId: string) {
    return this.zones.find((zone) => zone.id === zoneId) ?? null;
  }

  async save(zone: DeliveryZone, events: readonly DomainEvent[] = []) {
    const index = this.zones.findIndex((z) => z.id === zone.id);
    if (index >= 0) this.zones[index] = zone;
    else this.zones.push(zone);
    this.published.push(...events);
  }
}

/** Проверка вхождения точки в контур перебором рёбер — только для тестов. */
function contains(zone: DeliveryZone, point: Coordinates): boolean {
  const ring = zone.toLonLatRing();
  let inside = false;

  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const crosses =
      yi > point.latitude !== yj > point.latitude &&
      point.longitude < ((xj - xi) * (point.latitude - yi)) / (yj - yi) + xi;

    if (crosses) inside = !inside;
  }

  return inside;
}
