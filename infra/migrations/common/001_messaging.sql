-- Служебные таблицы гарантированной доставки событий.
-- Применяются ко ВСЕМ базам сервисов: каждый сервис и публикует, и потребляет.
--
-- outbox_messages — событие записывается в одной транзакции с изменением данных,
-- отдельный процесс публикует его в брокер. Без этого событие теряется при сбое
-- между фиксацией транзакции и отправкой (требование REL-3).
--
-- inbox_messages — идентификаторы уже обработанных сообщений. Брокер гарантирует
-- доставку «хотя бы один раз», поэтому дубликаты неизбежны; первичный ключ
-- отсекает повторную обработку (требование REL-4).

CREATE TABLE IF NOT EXISTS outbox_messages (
    id             BIGSERIAL PRIMARY KEY,
    aggregate_type TEXT        NOT NULL,
    aggregate_id   UUID        NOT NULL,
    event_type     TEXT        NOT NULL,
    event_version  INTEGER     NOT NULL DEFAULT 1,
    payload        JSONB       NOT NULL,
    headers        JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at   TIMESTAMPTZ,
    attempts       INTEGER     NOT NULL DEFAULT 0,
    last_error     TEXT
);

-- Частичный индекс: публикующий процесс ищет только неопубликованные.
-- Опубликованные записи в индекс не попадают, поэтому он остаётся маленьким
-- даже когда таблица вырастает до миллионов строк.
CREATE INDEX IF NOT EXISTS ix_outbox_unpublished
    ON outbox_messages (created_at)
    WHERE published_at IS NULL;

CREATE TABLE IF NOT EXISTS inbox_messages (
    message_id   UUID        PRIMARY KEY,
    consumer     TEXT        NOT NULL,
    event_type   TEXT        NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Очистка старых записей о обработанных сообщениях выполняется по расписанию;
-- индекс нужен, чтобы она не приводила к полному просмотру таблицы.
CREATE INDEX IF NOT EXISTS ix_inbox_processed_at ON inbox_messages (processed_at);
