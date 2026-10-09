import type { Restaurant } from "../../domain/restaurant";
import type { DomainEvent } from "@food-delivery/shared";

/**
 * Порт — описание того, что сервису нужно от хранилища, без единого слова
 * о том, какое это хранилище. Слой application работает с этим интерфейсом,
 * а реализация (PostgreSQL) живёт в infrastructure и подставляется при запуске.
 *
 * Зачем: сценарий использования можно протестировать с простой заглушкой
 * вместо базы, а замена хранилища не затрагивает бизнес-логику.
 */
export interface RestaurantRepository {
  findActive(limit: number, offset: number): Promise<Restaurant[]>;
  findById(id: string): Promise<Restaurant | null>;
  countActive(): Promise<number>;
  /** Регистрация нового ресторана и правка сведений о нём (ADM-2). */
  save(restaurant: Restaurant, events?: readonly DomainEvent[]): Promise<void>;
}

/** Метка для внедрения зависимости: интерфейс существует только во время компиляции. */
export const RESTAURANT_REPOSITORY = Symbol("RestaurantRepository");
