-- Удаление блюда из текущего меню сохраняет историю стоп-листа и старые ссылки заказа.
ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_deleted BOOLEAN NOT NULL DEFAULT FALSE;
CREATE INDEX IF NOT EXISTS ix_menu_items_visible
    ON menu_items (restaurant_id, category_id, sort_order)
    WHERE is_deleted = FALSE;
