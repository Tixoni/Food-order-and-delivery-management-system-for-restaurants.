-- Маршрут доставки «ресторан → клиент» (DLV-6). Продолжает 005_search_round.sql.
--
-- Считается маршрутизатором OSRM один раз на доставку: точки выдачи и
-- вручения не меняются. Отдельная таблица, а не колонки в deliveries:
-- маршрут — производные данные, его можно пересчитать в любой момент, и
-- он не должен утяжелять каждое чтение доставки при подборе. Строки нет —
-- маршрутизатор был недоступен (REL-2): экраны рисуют прямую, прогноз
-- считается по прямой с поправкой на улицы.

CREATE TABLE IF NOT EXISTS delivery_routes (
    delivery_id  UUID PRIMARY KEY REFERENCES deliveries (id) ON DELETE CASCADE,
    -- Длина пути по дорогам — основа прогноза времени в пути.
    distance_m   INTEGER NOT NULL CHECK (distance_m >= 0),
    -- Упрощённая линия для карты (overview=simplified): десятки точек, а не тысячи.
    path         GEOGRAPHY(LineString, 4326) NOT NULL,
    planned_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
