ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS time_zone VARCHAR(64) NOT NULL DEFAULT 'Europe/Moscow';

-- Один интервал в день поддерживает переход через полночь; равные границы запрещены.
ALTER TABLE restaurant_schedules
    ADD CONSTRAINT restaurant_schedules_nonzero_interval CHECK (opens_at <> closes_at);
