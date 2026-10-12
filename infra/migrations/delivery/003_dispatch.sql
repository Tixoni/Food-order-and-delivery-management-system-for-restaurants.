-- Подбор и назначение курьеров (итерация 3).
-- Продолжает 002_deliveries.sql.

-- ─────────────── Доставки: что нужно для подбора и прав ───────────────
-- restaurant_id и customer_id — копии идентификаторов без внешних ключей:
-- ресторан принадлежит каталогу, клиент — провайдеру входа. customer_id
-- нужен для SEC-7: позицию курьера видит только клиент этого заказа.
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS restaurant_id   UUID;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS customer_id     UUID;
-- Когда заказ будет готов: курьера зовут параллельно с готовкой
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS ready_at        TIMESTAMPTZ;
-- Ключ последнего запроса курьера от order: повтор с тем же ключом —
-- тот же ответ, новый ключ (после «курьер не найден») — новый поиск
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS request_key     VARCHAR(100);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS not_found_at    TIMESTAMPTZ;
-- Сквозной идентификатор запроса: фоновые шаги подбора продолжают его (OBS-2)
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS correlation_id  VARCHAR(100);

-- ─────────────── Курьер ↔ учётная запись ───────────────
-- Курьер действует от своей учётной записи Keycloak; одна запись — один курьер
CREATE UNIQUE INDEX IF NOT EXISTS ux_couriers_user
    ON couriers (user_id)
    WHERE user_id IS NOT NULL;

-- ─────────────── Предложения ───────────────
-- Отмена заказа закрывает открытое предложение: это не отказ курьера
-- и не молчание, поэтому отдельный ответ CANCELLED
ALTER TABLE delivery_assignments
    DROP CONSTRAINT IF EXISTS delivery_assignments_response_check;
ALTER TABLE delivery_assignments
    ADD CONSTRAINT delivery_assignments_response_check
    CHECK (response IN ('ACCEPTED', 'REJECTED', 'TIMEOUT', 'CANCELLED'));

-- Не больше одного открытого предложения на доставку: подбор с двух
-- экземпляров сервиса не предложит заказ двум курьерам сразу
CREATE UNIQUE INDEX IF NOT EXISTS ux_delivery_assignments_open
    ON delivery_assignments (delivery_id)
    WHERE response IS NULL;

-- Открытое предложение курьера — для экрана курьера
CREATE INDEX IF NOT EXISTS ix_delivery_assignments_courier_open
    ON delivery_assignments (courier_id)
    WHERE response IS NULL;
