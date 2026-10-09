/**
 * События каталога — топик `catalog.events`.
 *
 * Контракт между сервисом каталога и его потребителями (прежде всего шлюзом,
 * который держит кэш меню). Типы лежат в общем пакете, а не внутри сервиса,
 * именно для того, чтобы потребитель и отправитель не могли разойтись:
 * изменение поля у отправителя ломает сборку потребителя, а не работу
 * системы в рабочем окружении.
 *
 * Ключ партиции — `restaurantId`: все события одного ресторана попадают
 * в одну партицию и обрабатываются по порядку. Иначе «блюдо вернули»
 * может обогнать «блюдо убрали», и кэш останется с неверным состоянием.
 */

export const CATALOG_EVENT_TYPES = {
  menuItemStopped: "MenuItemStopped",
  menuItemRestored: "MenuItemRestored",
  menuUpdated: "MenuUpdated",
  menuStructureChanged: "MenuStructureChanged",
  restaurantChanged: "RestaurantChanged",
  deliveryZoneChanged: "DeliveryZoneChanged",
} as const;

export type CatalogEventType = (typeof CATALOG_EVENT_TYPES)[keyof typeof CATALOG_EVENT_TYPES];

/** Общая часть всех событий каталога: по ней потребитель понимает, чей кэш сбрасывать. */
export interface CatalogEventBase {
  restaurantId: string;
}

/** Блюдо убрано из продажи (CAT-4). */
export interface MenuItemStoppedPayload extends CatalogEventBase {
  menuItemId: string;
  name: string;
  /** Причина со слов сотрудника; может отсутствовать. */
  reason: string | null;
  stoppedAt: string;
}

/** Блюдо возвращено в продажу. */
export interface MenuItemRestoredPayload extends CatalogEventBase {
  menuItemId: string;
  name: string;
  restoredAt: string;
  /** Сколько минут блюдо отсутствовало в продаже — материал для показателей ADM-4. */
  outageMinutes: number;
}

/** Меню изменено менеджером (CAT-5). */
export interface MenuUpdatedPayload extends CatalogEventBase {
  menuItemId: string;
  name: string;
  /** Что именно произошло — потребителю кэша достаточно знать ресторан. */
  change: "created" | "updated" | "deleted";
}

export interface MenuStructureChangedPayload extends CatalogEventBase {
  resource: "category" | "modifiers";
  resourceId: string;
}

/** Меняется состав или содержимое общих списков ресторанов. */
export interface RestaurantChangedPayload extends CatalogEventBase {
  change: "created" | "updated";
}

export interface DeliveryZoneChangedPayload extends CatalogEventBase {
  zoneId: string;
  change: "created" | "updated";
}

export type CatalogEventPayload =
  | MenuItemStoppedPayload
  | MenuItemRestoredPayload
  | MenuUpdatedPayload
  | MenuStructureChangedPayload
  | RestaurantChangedPayload
  | DeliveryZoneChangedPayload;
