# Многоэтапная сборка: инструменты сборки остаются в первом образе
# и в итоговый не попадают. Это уменьшает размер и сокращает
# поверхность атаки — требование из «17 — Контейнеризация».
#
# Контекст сборки — корень репозитория, потому что сервис зависит
# от общего пакета из packages/shared.

# ─────────── Этап 1: сборка ───────────
FROM node:22-alpine AS builder

WORKDIR /app

# Сначала только описания пакетов: пока они не менялись, слой с установкой
# зависимостей берётся из кэша и пересобирать его не нужно.
COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/catalog/package.json ./apps/catalog/

RUN npm ci

COPY packages ./packages
COPY apps/catalog ./apps/catalog

RUN npm run build -w @food-delivery/shared \
    && npm run build -w @food-delivery/catalog \
    && npm prune --omit=dev

# ─────────── Этап 2: выполнение ───────────
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

# Работа от непривилегированного пользователя: в образе node такой уже есть.
COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/apps/catalog/package.json ./apps/catalog/
COPY --from=builder --chown=node:node /app/apps/catalog/dist ./apps/catalog/dist

USER node

EXPOSE 3001

# Проверка «процесс жив» — по ней оркестратор решает, не перезапустить ли контейнер.
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3001/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/catalog/dist/main.js"]
