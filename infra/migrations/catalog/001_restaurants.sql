-- Первая таблица каталога. Полная схема меню, модификаторов и зон доставки
-- добавляется на шаге 0.6; здесь — минимум, на котором проверяется каркас сервиса.

CREATE TABLE IF NOT EXISTS restaurants (
    id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name                 VARCHAR(200)  NOT NULL,
    description          VARCHAR(1000),
    phone                VARCHAR(32),
    address_text         VARCHAR(500),
    location             GEOGRAPHY(Point, 4326),
    -- Деньги хранятся целыми копейками: дробный тип для денег недопустим
    min_order_amount     INTEGER       NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
    delivery_fee_base    INTEGER       NOT NULL DEFAULT 0 CHECK (delivery_fee_base >= 0),
    avg_cooking_time_min INTEGER       NOT NULL DEFAULT 30 CHECK (avg_cooking_time_min > 0),
    is_active            BOOLEAN       NOT NULL DEFAULT TRUE,
    created_at           TIMESTAMPTZ   NOT NULL DEFAULT now(),
    updated_at           TIMESTAMPTZ   NOT NULL DEFAULT now()
);

-- Пространственный индекс по положению ресторана
CREATE INDEX IF NOT EXISTS ix_restaurants_location ON restaurants USING GIST (location);

-- Частичный индекс: выдача клиенту всегда фильтрует по действующим
CREATE INDEX IF NOT EXISTS ix_restaurants_active ON restaurants (name) WHERE is_active;
