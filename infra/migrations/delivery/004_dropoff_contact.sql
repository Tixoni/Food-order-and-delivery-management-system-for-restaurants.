-- Что нужно курьеру, чтобы довезти заказ: номер для ресторана, адрес
-- и телефон клиента. Состав и цены доставке не нужны — для неё заказ —
-- это адрес и контакт. Продолжает 003_dispatch.sql.
--
-- Телефон клиента курьер видит только после того, как принял заказ:
-- за 90 секунд предложения номер не должен расходиться по всем
-- курьерам района (152-ФЗ, минимизация персональных данных — SEC-4).

ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS order_number    INTEGER;
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS dropoff_address VARCHAR(500);
ALTER TABLE deliveries ADD COLUMN IF NOT EXISTS contact_phone   VARCHAR(32);
