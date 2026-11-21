CREATE INDEX IF NOT EXISTS ix_orders_placed_at ON orders (placed_at DESC);
CREATE INDEX IF NOT EXISTS ix_orders_delivered_at ON orders (delivered_at)
    WHERE delivered_at IS NOT NULL;
