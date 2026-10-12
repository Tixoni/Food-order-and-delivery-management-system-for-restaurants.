# Создано по образцу сервиса catalog. Многоэтапная сборка: инструменты сборки остаются
# в первом образе и в итоговый не попадают.
# Контекст сборки — корень репозитория: сервис зависит от общих пакетов.

# ─────────── Этап 1: сборка ───────────
FROM node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/shared/package.json ./packages/shared/
COPY packages/service-kit/package.json ./packages/service-kit/
COPY packages/contracts/package.json ./packages/contracts/
COPY apps/delivery/package.json ./apps/delivery/

RUN npm ci

COPY packages ./packages
COPY apps/delivery ./apps/delivery

RUN npm run build -w @food-delivery/shared \
    && npm run build -w @food-delivery/service-kit \
    && npm run build -w @food-delivery/contracts \
    && npm run build -w @food-delivery/delivery \
    && npm prune --omit=dev

# ─────────── Этап 2: выполнение ───────────
FROM node:22-alpine AS runtime

WORKDIR /app
ENV NODE_ENV=production

COPY --from=builder --chown=node:node /app/node_modules ./node_modules
COPY --from=builder --chown=node:node /app/packages/shared/package.json ./packages/shared/
COPY --from=builder --chown=node:node /app/packages/shared/dist ./packages/shared/dist
COPY --from=builder --chown=node:node /app/packages/service-kit/package.json ./packages/service-kit/
COPY --from=builder --chown=node:node /app/packages/service-kit/dist ./packages/service-kit/dist
COPY --from=builder --chown=node:node /app/packages/contracts/package.json ./packages/contracts/
COPY --from=builder --chown=node:node /app/packages/contracts/dist ./packages/contracts/dist
COPY --from=builder --chown=node:node /app/apps/delivery/package.json ./apps/delivery/
COPY --from=builder --chown=node:node /app/apps/delivery/dist ./apps/delivery/dist

USER node

EXPOSE 3004

HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
    CMD node -e "fetch('http://127.0.0.1:3004/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "apps/delivery/dist/main.js"]
