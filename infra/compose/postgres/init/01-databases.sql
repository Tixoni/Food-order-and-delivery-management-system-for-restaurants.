-- Каждый сервис владеет своими данными и не читает чужие таблицы.
-- В прототипе это четыре логические базы на одном экземпляре PostgreSQL —
-- осознанный компромисс ради экономии памяти. В целевой системе это
-- отдельные экземпляры. См. заметку «10 — Модель данных».

CREATE DATABASE catalog_db;
CREATE DATABASE order_db;
CREATE DATABASE payment_db;
CREATE DATABASE delivery_db;

-- Географическое расширение нужно каталогу (зоны доставки),
-- доставке (позиции курьеров) и заказам (точка доставки).
\connect catalog_db
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

\connect order_db
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

\connect payment_db
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

\connect delivery_db
CREATE EXTENSION IF NOT EXISTS postgis;
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
