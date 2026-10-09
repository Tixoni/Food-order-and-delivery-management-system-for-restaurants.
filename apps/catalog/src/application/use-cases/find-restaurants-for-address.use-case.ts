import { Inject, Injectable } from "@nestjs/common";
import { ValidationError } from "@food-delivery/shared";
import { Coordinates, CoordinatesError } from "../../domain/coordinates";
import {
  DELIVERY_ZONE_REPOSITORY,
  type DeliveryOffer,
  type DeliveryZoneRepository,
} from "../ports/delivery-zone.repository";

/**
 * Требование CAT-1: клиент вводит адрес и видит рестораны, которые
 * по нему доставляют.
 *
 * Это первый экран приложения: с него начинается любой заказ, и от его
 * скорости зависит впечатление обо всей системе. Отсюда требование PERF-5 —
 * ответ не дольше 150 мс на 500 ресторанах.
 *
 * Перевод адреса в координаты (геокодирование) выполняет клиентская часть:
 * там уже есть карта, и незачем держать в сервисе второй справочник адресов.
 * Сервис работает с координатами — они однозначны, в отличие от текста адреса.
 */

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export interface FindRestaurantsForAddressQuery {
  latitude: number;
  longitude: number;
  limit?: number;
}

@Injectable()
export class FindRestaurantsForAddressUseCase {
  constructor(@Inject(DELIVERY_ZONE_REPOSITORY) private readonly zones: DeliveryZoneRepository) {}

  async execute(query: FindRestaurantsForAddressQuery): Promise<DeliveryOffer[]> {
    const point = this.toPoint(query);

    const limit = query.limit ?? DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
      throw new ValidationError(`limit должен быть целым числом от 1 до ${MAX_LIMIT}`, { limit });
    }

    return this.zones.findRestaurantsDeliveringTo(point, limit);
  }

  /**
   * Неверные координаты — ошибка пользователя, а не сбой системы:
   * клиент должен получить ответ с кодом 400 и понятным текстом,
   * а не «внутреннюю ошибку сервиса».
   */
  private toPoint(query: FindRestaurantsForAddressQuery): Coordinates {
    try {
      return Coordinates.create({ latitude: query.latitude, longitude: query.longitude });
    } catch (error) {
      if (error instanceof CoordinatesError) {
        throw new ValidationError(error.message, {
          latitude: query.latitude,
          longitude: query.longitude,
        });
      }
      throw error;
    }
  }
}
