import type { GeoPoint } from "../../domain/geo";

/**
 * Поток геопозиции — телеметрия, а не доменные события (DLV-2, TRK-2).
 *
 * Актуальная позиция живёт в кэше и рассылается подписчикам канала
 * заказа; в брокер она не попадает — `order` этот поток не нужен.
 * История пишется в базу пачками: одна транзакция на каждую координату —
 * самый дорогой способ хранить самые дешёвые данные.
 */

export interface Position extends GeoPoint {
  at: Date;
  accuracy?: number | null;
  speed?: number | null;
}

export interface PositionCache {
  /** Актуальная позиция курьера; живёт недолго — потерявший связь курьер «устаревает». */
  save(courierId: string, position: Position): Promise<void>;
  get(courierId: string): Promise<Position | null>;
  /** Рассылка позиции клиенту заказа: канал `ws:order:{orderId}` (PERF-3). */
  publish(orderId: string, payload: unknown): Promise<void>;
}

export interface LocationHistory {
  /** Поставить координату в очередь пакетной записи. */
  add(courierId: string, position: Position): void;
}

export const POSITION_CACHE = Symbol("PositionCache");
export const LOCATION_HISTORY = Symbol("LocationHistory");
