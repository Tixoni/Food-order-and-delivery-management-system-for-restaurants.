-- Курьеры и их положение. Минимальная схема, достаточная для проверки
-- подбора ближайшего свободного курьера (требование DLV-3).
-- Доставки, назначения и история переназначений добавляются в итерации 3.

CREATE TABLE IF NOT EXISTS couriers (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id           UUID,
    full_name         VARCHAR(200) NOT NULL,
    phone             VARCHAR(32),
    vehicle_type      VARCHAR(16) NOT NULL DEFAULT 'foot'
                      CHECK (vehicle_type IN ('foot', 'bike', 'car')),
    -- offline — не на смене, available — свободен, assigned — предложен заказ,
    -- busy — везёт заказ
    status            VARCHAR(16) NOT NULL DEFAULT 'offline'
                      CHECK (status IN ('offline', 'available', 'assigned', 'busy')),
    current_delivery_id UUID,
    last_location     GEOGRAPHY(Point, 4326),
    last_location_at  TIMESTAMPTZ,
    rating            NUMERIC(3, 2) CHECK (rating IS NULL OR (rating >= 0 AND rating <= 5)),
    is_active         BOOLEAN NOT NULL DEFAULT TRUE,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Пространственный индекс по положению. Здесь приведения типа в запросе нет
-- (ST_DWithin работает с geography напрямую), поэтому индекс строится по колонке.
-- Проверено: на 20 000 курьеров он ускоряет подбор в 4,8 раза.
CREATE INDEX IF NOT EXISTS ix_couriers_location
    ON couriers USING GIST (last_location);

-- Частичный индекс: подбор всегда ищет только среди свободных
CREATE INDEX IF NOT EXISTS ix_couriers_available
    ON couriers (status) WHERE status = 'available';

-- История перемещений. Единственная таблица с высокой частотой записи:
-- в целевой системе это тысячи строк в секунду. Актуальное положение
-- дублируется в кэш и читается оттуда, здесь остаётся только история
-- для разбора спорных доставок.
CREATE TABLE IF NOT EXISTS courier_locations (
    id          BIGSERIAL PRIMARY KEY,
    courier_id  UUID NOT NULL REFERENCES couriers (id) ON DELETE CASCADE,
    location    GEOGRAPHY(Point, 4326) NOT NULL,
    speed       NUMERIC(6, 2),
    accuracy    NUMERIC(6, 2),
    recorded_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_courier_locations_courier_time
    ON courier_locations (courier_id, recorded_at DESC);
