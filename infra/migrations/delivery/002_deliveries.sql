-- Доставки, смены и история предложений курьерам.
-- Продолжает 001_couriers.sql.
--
-- Статус заказа доставка не меняет: она публикует события, переход
-- выполняет order. Поэтому order_id здесь — копия идентификатора без внешнего ключа.

-- ─────────────── Смены ───────────────
-- Позиция принимается и курьер участвует в подборе только на смене
CREATE TABLE IF NOT EXISTS courier_shifts (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    courier_id UUID        NOT NULL REFERENCES couriers (id) ON DELETE CASCADE,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at   TIMESTAMPTZ,
    CHECK (ended_at IS NULL OR ended_at > started_at)
);

-- Не больше одной открытой смены на курьера
CREATE UNIQUE INDEX IF NOT EXISTS ux_courier_shifts_open
    ON courier_shifts (courier_id)
    WHERE ended_at IS NULL;

-- ─────────────── Доставки ───────────────
CREATE TABLE IF NOT EXISTS deliveries (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id           UUID        NOT NULL,
    courier_id         UUID REFERENCES couriers (id) ON DELETE SET NULL,
    pickup_location    GEOGRAPHY(Point, 4326) NOT NULL,
    dropoff_location   GEOGRAPHY(Point, 4326) NOT NULL,
    status             VARCHAR(16) NOT NULL DEFAULT 'PENDING'
                       CHECK (status IN ('PENDING', 'ASSIGNED', 'PICKED_UP',
                                         'DELIVERED', 'CANCELLED')),
    -- Расстояние и время по маршруту OSRM, а не по прямой
    distance_m         INTEGER CHECK (distance_m IS NULL OR distance_m >= 0),
    route_duration_sec INTEGER CHECK (route_duration_sec IS NULL OR route_duration_sec >= 0),
    eta_at             TIMESTAMPTZ,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    assigned_at        TIMESTAMPTZ,
    accepted_at        TIMESTAMPTZ,
    picked_up_at       TIMESTAMPTZ,
    delivered_at       TIMESTAMPTZ,
    cancelled_at       TIMESTAMPTZ,
    version            INTEGER     NOT NULL DEFAULT 1,
    CHECK (status = 'PENDING' OR status = 'CANCELLED' OR courier_id IS NOT NULL)
);

-- Одна действующая доставка на заказ: повторное событие о готовности
-- заказа не создаёт вторую доставку
CREATE UNIQUE INDEX IF NOT EXISTS ux_deliveries_order_active
    ON deliveries (order_id)
    WHERE status <> 'CANCELLED';

CREATE INDEX IF NOT EXISTS ix_deliveries_courier_active
    ON deliveries (courier_id)
    WHERE status IN ('ASSIGNED', 'PICKED_UP');

-- ─────────────── Предложения курьерам ───────────────
-- Прямая реализация DLV-4: каждое предложение — отдельная строка с номером
-- попытки, по ней видно, сколько раз заказ переназначался.
CREATE TABLE IF NOT EXISTS delivery_assignments (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    delivery_id  UUID        NOT NULL REFERENCES deliveries (id) ON DELETE CASCADE,
    courier_id   UUID        NOT NULL REFERENCES couriers (id) ON DELETE CASCADE,
    sequence     SMALLINT    NOT NULL CHECK (sequence > 0),
    offered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    -- Срок отклика 90 с; по нему таймер переназначает заказ
    expires_at   TIMESTAMPTZ NOT NULL DEFAULT now() + INTERVAL '90 seconds',
    responded_at TIMESTAMPTZ,
    response     VARCHAR(16)
                 CHECK (response IN ('ACCEPTED', 'REJECTED', 'TIMEOUT')),
    UNIQUE (delivery_id, sequence),
    CHECK ((response IS NULL) = (responded_at IS NULL))
);

-- Поиск просроченных предложений без ответа
CREATE INDEX IF NOT EXISTS ix_delivery_assignments_pending
    ON delivery_assignments (expires_at)
    WHERE response IS NULL;

-- Связь курьера с текущей доставкой. Объявляется после создания deliveries,
-- поэтому отдельной командой; повторный запуск её пропускает.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_couriers_current_delivery') THEN
        ALTER TABLE couriers
            ADD CONSTRAINT fk_couriers_current_delivery
            FOREIGN KEY (current_delivery_id) REFERENCES deliveries (id) ON DELETE SET NULL;
    END IF;
END $$;
