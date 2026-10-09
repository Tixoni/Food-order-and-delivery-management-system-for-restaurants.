-- Схема платежей: текущее состояние платежа и неизменяемый журнал операций.
--
-- Две таблицы, а не одна: возврат не переписывает платёж, а добавляет запись
-- в журнал. Это аудируемость денежных операций и основа частичного возврата
-- (PAY-6) — несколько записей возврата на один платёж.
--
-- Данных банковских карт здесь нет и не будет — только идентификатор платежа
-- у провайдера (SEC-3). Отсутствие такой таблицы — проектное решение.
--
-- Деньги — целые копейки, как в каталоге и заказах.

-- ─────────────── Платежи ───────────────
CREATE TABLE IF NOT EXISTS payments (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    order_id            UUID        NOT NULL,
    customer_id         UUID        NOT NULL,
    amount              INTEGER     NOT NULL CHECK (amount > 0),
    -- Сумма уже возвращённых средств: возврат сверх списанного запрещён
    refunded_amount     INTEGER     NOT NULL DEFAULT 0,
    currency            CHAR(3)     NOT NULL DEFAULT 'RUB',
    -- VOIDED (снят холд) и REFUNDED (возвращены списанные) — разные операции
    -- с разными последствиями, поэтому и разные статусы
    status              VARCHAR(24) NOT NULL DEFAULT 'PENDING'
                        CHECK (status IN ('PENDING', 'AUTHORIZED', 'CAPTURED', 'REFUNDED',
                                          'PARTIALLY_REFUNDED', 'DECLINED', 'VOIDED')),
    provider            VARCHAR(32) NOT NULL DEFAULT 'yookassa-emulator',
    provider_payment_id VARCHAR(100),
    idempotency_key     VARCHAR(100) NOT NULL,
    authorized_at       TIMESTAMPTZ,
    captured_at         TIMESTAMPTZ,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    version             INTEGER     NOT NULL DEFAULT 1,
    CHECK (refunded_amount >= 0 AND refunded_amount <= amount)
);

-- PAY-4: повтор вызова при обрыве связи не должен списать деньги дважды.
-- Повтор ловится конфликтом вставки, а не выборкой «сначала проверить».
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_idempotency_key
    ON payments (idempotency_key);

CREATE INDEX IF NOT EXISTS ix_payments_order ON payments (order_id);

-- Не больше одного действующего платежа на заказ; отклонённые и снятые
-- не мешают повторной попытке оплаты
CREATE UNIQUE INDEX IF NOT EXISTS ux_payments_order_active
    ON payments (order_id)
    WHERE status NOT IN ('DECLINED', 'VOIDED');

-- ─────────────── Журнал операций ───────────────
-- Только добавление. Каждая операция — отдельная строка со своим ключом,
-- который передаётся провайдеру тем же значением.
CREATE TABLE IF NOT EXISTS payment_transactions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    payment_id      UUID         NOT NULL REFERENCES payments (id) ON DELETE RESTRICT,
    type            VARCHAR(16)  NOT NULL
                    CHECK (type IN ('AUTHORIZE', 'CAPTURE', 'REFUND', 'VOID')),
    amount          INTEGER      NOT NULL CHECK (amount > 0),
    status          VARCHAR(16)  NOT NULL DEFAULT 'PENDING'
                    CHECK (status IN ('PENDING', 'SUCCEEDED', 'FAILED')),
    provider_ref    VARCHAR(100),
    idempotency_key VARCHAR(100) NOT NULL,
    request         JSONB,
    response        JSONB,
    error_code      VARCHAR(64),
    created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
    finished_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX IF NOT EXISTS ux_payment_transactions_idempotency_key
    ON payment_transactions (idempotency_key);

CREATE INDEX IF NOT EXISTS ix_payment_transactions_payment
    ON payment_transactions (payment_id, created_at);

-- Сверка зависших операций с провайдером после сбоя: ищутся только
-- незавершённые, поэтому индекс частичный
CREATE INDEX IF NOT EXISTS ix_payment_transactions_pending
    ON payment_transactions (created_at)
    WHERE status = 'PENDING';
