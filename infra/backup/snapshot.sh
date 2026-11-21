#!/bin/sh
set -eu

snapshot() (
  stamp=$(date +%s)
  temporary=$(mktemp -d "/backups/.partial-$stamp-XXXXXXXX") || exit 1
  trap 'rm -rf -- "$temporary"' EXIT
  pg_basebackup -h /var/run/postgresql -U "$POSTGRES_USER" -D "$temporary" \
    --format=plain --wal-method=stream --checkpoint=fast --no-password || exit 1
  suffix=${temporary##*-}
  mv "$temporary" "/backups/snapshot-$stamp-$suffix" || exit 1
  printf 'Снимок PostgreSQL сохранён. Возраст точки сохранения: %s с\n' "$(( $(date +%s) - stamp ))"
  find /backups -mindepth 1 -maxdepth 1 -type d -name 'snapshot-*' |
    sort -r | tail -n +13 | while IFS= read -r old; do
      rm -rf -- "$old"
    done
)

chmod 700 /backups
if [ "${1:-loop}" = once ]; then
  snapshot
else
  while :; do
    snapshot || printf 'Снимок PostgreSQL не завершился. Сохраняется предыдущая копия.\n' >&2
    sleep 300
  done
fi
