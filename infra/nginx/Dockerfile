# Обратный прокси — единственный открытый вход системы в окружении apps/full.
# Отдаёт собранное клиентское приложение и распределяет запросы между
# репликами шлюза и каталога (SCAL-2). Контекст сборки — корень репозитория.

# ─────────── Этап 1: сборка клиентского приложения ───────────
FROM node:22-alpine AS web

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/web/package.json ./apps/web/

RUN npm ci

COPY apps/web ./apps/web

RUN npm run build -w @food-delivery/web

# ─────────── Этап 2: прокси ───────────
FROM nginx:1.28.0-alpine3.21

COPY infra/nginx/nginx.conf /etc/nginx/nginx.conf
COPY --from=web /app/apps/web/dist /usr/share/nginx/html

EXPOSE 8080 8081

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
    CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
