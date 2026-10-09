import { createEvent } from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES } from "@food-delivery/contracts";
import { loadConfig } from "../config/configuration";
import { CatalogCache } from "./catalog.cache";
import { CatalogEventsConsumer } from "./catalog-events.consumer";

describe("сброс общего Redis-кэша по событиям каталога", () => {
  const build = () => {
    const cache = {
      invalidateRestaurant: jest.fn().mockResolvedValue(undefined),
      invalidateListings: jest.fn().mockResolvedValue(undefined),
    };
    const consumer = new CatalogEventsConsumer(loadConfig(), cache as unknown as CatalogCache);
    return { cache, consumer };
  };

  const message = (eventType: string) =>
    JSON.stringify(
      createEvent({
        eventType,
        aggregateType: "Restaurant",
        aggregateId: "r-1",
        correlationId: "test-correlation",
        payload: { restaurantId: "r-1" },
      }),
    );

  it("изменение меню сбрасывает только кэш ресторана", async () => {
    const { cache, consumer } = build();
    await consumer["handle"](message(CATALOG_EVENT_TYPES.menuUpdated));
    expect(cache.invalidateRestaurant).toHaveBeenCalledWith("r-1");
    expect(cache.invalidateListings).not.toHaveBeenCalled();
  });

  it.each([CATALOG_EVENT_TYPES.restaurantChanged, CATALOG_EVENT_TYPES.deliveryZoneChanged])(
    "%s сбрасывает и карточку, и общие списки",
    async (eventType) => {
      const { cache, consumer } = build();
      await consumer["handle"](message(eventType));
      expect(cache.invalidateRestaurant).toHaveBeenCalledWith("r-1");
      expect(cache.invalidateListings).toHaveBeenCalledTimes(1);
    },
  );
});
