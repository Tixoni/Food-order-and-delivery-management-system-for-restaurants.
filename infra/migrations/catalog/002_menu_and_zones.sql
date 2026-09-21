-- Полная схема каталога: меню, модификаторы, стоп-листы, зоны доставки.
-- Продолжает 001_restaurants.sql.

-- ─────────────── Расписание работы ───────────────
-- Требование CAT-7: вне часов работы заказ оформить нельзя.
CREATE TABLE IF NOT EXISTS restaurant_schedules (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID     NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
    day_of_week   SMALLINT NOT NULL CHECK (day_of_week BETWEEN 0 AND 6),
    opens_at      TIME     NOT NULL,
    closes_at     TIME     NOT NULL,
    UNIQUE (restaurant_id, day_of_week)
);

-- ─────────────── Зоны доставки ───────────────
-- Требование CAT-1: «какие рестораны доставляют по этому адресу».
CREATE TABLE IF NOT EXISTS delivery_zones (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id    UUID    NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
    name             VARCHAR(200) NOT NULL DEFAULT 'Основная зона',
    area             GEOGRAPHY(MultiPolygon, 4326) NOT NULL,
    delivery_fee     INTEGER NOT NULL DEFAULT 0 CHECK (delivery_fee >= 0),
    min_order_amount INTEGER NOT NULL DEFAULT 0 CHECK (min_order_amount >= 0),
    is_active        BOOLEAN NOT NULL DEFAULT TRUE,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ВАЖНО: индекс строится по ВЫРАЖЕНИЮ area::geometry, а не по самой колонке.
-- Проверено экспериментально (заметка «28 — Спайк 1»): запрос ST_Contains
-- приводит колонку к типу geometry, и обычный индекс по geography к такому
-- выражению неприменим — база переходит на полный просмотр таблицы.
-- На 50 000 зон разница составила 27,2 мс против 2,4 мс, то есть 11,5 раза.
CREATE INDEX IF NOT EXISTS ix_delivery_zones_area_geom
    ON delivery_zones USING GIST ((area::geometry));

CREATE INDEX IF NOT EXISTS ix_delivery_zones_restaurant
    ON delivery_zones (restaurant_id) WHERE is_active;

-- ─────────────── Категории меню ───────────────
CREATE TABLE IF NOT EXISTS menu_categories (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID    NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
    name          VARCHAR(200) NOT NULL,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    is_active     BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS ix_menu_categories_restaurant
    ON menu_categories (restaurant_id, sort_order);

-- ─────────────── Блюда ───────────────
CREATE TABLE IF NOT EXISTS menu_items (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    restaurant_id UUID    NOT NULL REFERENCES restaurants (id) ON DELETE CASCADE,
    category_id   UUID    NOT NULL REFERENCES menu_categories (id) ON DELETE CASCADE,
    name          VARCHAR(200)  NOT NULL,
    description   VARCHAR(1000),
    composition   VARCHAR(1000),
    -- Деньги — целые копейки
    price         INTEGER NOT NULL CHECK (price >= 0),
    image_url     VARCHAR(500),
    weight_grams  INTEGER CHECK (weight_grams IS NULL OR weight_grams > 0),
    calories      INTEGER CHECK (calories IS NULL OR calories >= 0),
    -- Стоп-лист: быстрое текущее состояние для выдачи
    is_available  BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order    INTEGER NOT NULL DEFAULT 0,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_menu_items_category
    ON menu_items (restaurant_id, category_id, sort_order);

-- Частичный индекс: выдача клиенту всегда фильтрует по доступным блюдам
CREATE INDEX IF NOT EXISTS ix_menu_items_available
    ON menu_items (restaurant_id) WHERE is_available;

-- Полнотекстовый поиск по названию и составу (требование CAT-6).
-- Встроенных средств PostgreSQL достаточно для объёма прототипа —
-- отдельный поисковый движок подключается только при запасе времени.
CREATE INDEX IF NOT EXISTS ix_menu_items_search
    ON menu_items USING GIN (
        to_tsvector('russian', coalesce(name, '') || ' ' || coalesce(composition, ''))
    );

-- ─────────────── Модификаторы блюда ───────────────
-- Требование CAT-3: размер, добавки и прочее, влияющее на цену.
CREATE TABLE IF NOT EXISTS item_option_groups (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id   UUID    NOT NULL REFERENCES menu_items (id) ON DELETE CASCADE,
    name           VARCHAR(200) NOT NULL,
    -- single — выбрать ровно один вариант, multiple — несколько
    selection_type VARCHAR(16) NOT NULL DEFAULT 'single'
                   CHECK (selection_type IN ('single', 'multiple')),
    is_required    BOOLEAN NOT NULL DEFAULT FALSE,
    min_select     INTEGER NOT NULL DEFAULT 0 CHECK (min_select >= 0),
    max_select     INTEGER NOT NULL DEFAULT 1 CHECK (max_select >= 1),
    sort_order     INTEGER NOT NULL DEFAULT 0,
    CHECK (max_select >= min_select)
);

CREATE INDEX IF NOT EXISTS ix_option_groups_item
    ON item_option_groups (menu_item_id, sort_order);

CREATE TABLE IF NOT EXISTS item_options (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    group_id     UUID    NOT NULL REFERENCES item_option_groups (id) ON DELETE CASCADE,
    name         VARCHAR(200) NOT NULL,
    -- Надбавка к цене блюда; может быть отрицательной (скидка за меньший размер)
    price_delta  INTEGER NOT NULL DEFAULT 0,
    is_available BOOLEAN NOT NULL DEFAULT TRUE,
    sort_order   INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS ix_item_options_group
    ON item_options (group_id, sort_order);

-- ─────────────── История стоп-листа ───────────────
-- Текущее состояние лежит в menu_items.is_available — так выдача не требует
-- соединения таблиц. Здесь же копится история: какие блюда и как часто
-- заканчиваются (материал для витрины показателей ресторана, ADM-4).
CREATE TABLE IF NOT EXISTS stop_list_entries (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    menu_item_id UUID NOT NULL REFERENCES menu_items (id) ON DELETE CASCADE,
    reason       VARCHAR(500),
    stopped_by   UUID,
    stopped_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    restored_at  TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_stop_list_active
    ON stop_list_entries (menu_item_id) WHERE restored_at IS NULL;
