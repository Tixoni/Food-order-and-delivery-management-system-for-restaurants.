#!/bin/sh
set -eu

start=$(date +%s)
snapshot=$(find /backups -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' | sort -r | head -n 1)
if [ -z "$snapshot" ]; then
  printf 'Создайте резервную копию перед проверкой восстановления.\n' >&2
  exit 1
fi
stamp=${snapshot##*/snapshot-}
stamp=${stamp%%-*}
age=$((start - stamp))
pg_verifybackup "$snapshot"

work=$(mktemp -d)
data=$work/data
mkdir "$data"
cp -a "$snapshot"/. "$data"/
chown -R postgres:postgres "$work"
chmod 700 "$data"
trap 'gosu postgres pg_ctl -D "$data" -w -m fast stop >/dev/null 2>&1 || true' EXIT
gosu postgres pg_ctl -D "$data" -w -t 120 -l "$work/postgres.log" \
  -o "-c listen_addresses='' -k $work" start

count() {
  psql -X -h "$work" -U "$POSTGRES_USER" -d "$1" -v ON_ERROR_STOP=1 -Atc "$2"
}
restaurants=$(count "$CATALOG_DB" 'SELECT count(*) FROM restaurants')
orders=$(count "$ORDER_DB" 'SELECT count(*) FROM orders')
payments=$(count "$PAYMENT_DB" 'SELECT count(*) FROM payments')
couriers=$(count "$DELIVERY_DB" 'SELECT count(*) FROM couriers')
elapsed=$(( $(date +%s) - start ))
printf 'Восстановлено: рестораны %s, заказы %s, платежи %s, курьеры %s\n' "$restaurants" "$orders" "$payments" "$couriers"
printf 'Возраст снимка %s с, восстановление %s с\n' "$age" "$elapsed"
test "$age" -le 900 && test "$elapsed" -le 3600
