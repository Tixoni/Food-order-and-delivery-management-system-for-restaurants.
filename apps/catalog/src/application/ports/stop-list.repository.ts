import type { DomainEvent } from "@food-delivery/shared";
import type { MenuItem } from "../../domain/menu-item";
import type { StopListEntry } from "../../domain/stop-list";

/**
 * Что происходит при переводе блюда в стоп-лист и обратно.
 *
 * Три изменения объединены в один объект намеренно: они должны попасть
 * в базу одной транзакцией. Если признак доступности сохранится,
 * а событие — нет, кэш шлюза останется со старым меню и клиент закажет
 * то, чего нет на кухне. Разделить их на три вызова порта — значит
 * позволить такому расхождению случиться (требование REL-3).
 */
export interface AvailabilityChange {
  /** Блюдо с новым признаком доступности. */
  item: MenuItem;
  /** Запись журнала: открытая при переводе в стоп-лист, закрытая при возврате. */
  entry: StopListEntry;
  /** Что уйдёт в брокер. Пишется в таблицу исходящих сообщений той же транзакцией. */
  events: DomainEvent[];
}

export interface StopListRepository {
  /** Действующая запись стоп-листа по блюду или null, если блюдо в продаже. */
  findActiveEntry(menuItemId: string): Promise<StopListEntry | null>;

  /** Сохраняет признак, журнал и событие одной транзакцией. */
  commit(change: AvailabilityChange): Promise<void>;

  /** История стоп-листа ресторана, свежие записи первыми. Для панели менеджера. */
  findHistory(restaurantId: string, limit: number): Promise<StopListEntry[]>;
}

export const STOP_LIST_REPOSITORY = Symbol("StopListRepository");
