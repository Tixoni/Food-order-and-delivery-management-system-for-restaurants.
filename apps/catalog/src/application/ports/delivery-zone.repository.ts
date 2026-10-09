import type { Coordinates } from "../../domain/coordinates";
import type { DeliveryZone } from "../../domain/delivery-zone";
import type { Kopecks } from "../../domain/money";
import type { Restaurant } from "../../domain/restaurant";
import type { DomainEvent } from "@food-delivery/shared";

/**
 * Ресторан, который доставляет по запрошенному адресу, вместе с условиями
 * именно той зоны, в которую адрес попал. Клиенту нужно и то и другое сразу:
 * список ресторанов без стоимости доставки бесполезен — он всё равно
 * потребует по запросу на каждый ресторан.
 */
export interface DeliveryOffer {
  restaurant: Restaurant;
  zoneId: string;
  zoneName: string;
  deliveryFee: Kopecks;
  minOrderAmount: Kopecks;
}

export interface DeliveryZoneRepository {
  /**
   * Требование CAT-1: какие рестораны доставляют по этому адресу.
   *
   * Отбор и упорядочивание выполняет хранилище, а не вызывающий код:
   * зон могут быть тысячи, и отбирать их в памяти сервиса означало бы
   * вычитывать всю таблицу. Порядок — от дешёвой доставки к дорогой.
   */
  findRestaurantsDeliveringTo(point: Coordinates, limit: number): Promise<DeliveryOffer[]>;

  findOfferForRestaurant(point: Coordinates, restaurantId: string): Promise<DeliveryOffer | null>;

  /** Зоны ресторана, включая отключённые: менеджеру нужны все. */
  findByRestaurant(restaurantId: string): Promise<DeliveryZone[]>;

  findById(zoneId: string): Promise<DeliveryZone | null>;

  save(zone: DeliveryZone, events?: readonly DomainEvent[]): Promise<void>;
}

export const DELIVERY_ZONE_REPOSITORY = Symbol("DeliveryZoneRepository");
