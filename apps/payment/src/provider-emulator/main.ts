import "./tracing";
import { createLogger } from "@food-delivery/shared";
import { DEFAULT_SETTINGS, ProviderEmulator, type EmulatorSettings } from "./emulator";
import { startEmulatorServer } from "./server";

/**
 * Запуск эмулятора платёжного провайдера отдельным процессом:
 * `node apps/payment/dist/provider-emulator/main.js`.
 *
 * Отдельный процесс, а не класс внутри сервиса платежей: между ними
 * настоящая сеть, поэтому таймауты, повторы и размыкатель проверяются
 * на настоящих отказах, а остановка контейнера эмулятора изображает
 * недоступность провайдера (REL-2).
 *
 * Начальные режимы — переменными окружения, дальше — на лету через
 * `POST /_emulator/settings`.
 */
const logger = createLogger({
  service: "payment-provider-emulator",
  level: (process.env.LOG_LEVEL as "info") ?? "info",
});

const operation = (name: string) => {
  const value = process.env[name];
  return value ? (value as EmulatorSettings["failOperation"]) : null;
};

const settings: EmulatorSettings = {
  ...DEFAULT_SETTINGS,
  failOperation: operation("EMULATOR_FAIL_OPERATION"),
  loseResponseOperation: operation("EMULATOR_LOSE_RESPONSE_OPERATION"),
  failureRate: Number(process.env.EMULATOR_FAILURE_RATE ?? 0),
  delayMs: Number(process.env.EMULATOR_DELAY_MS ?? 0),
  declineAbove: process.env.EMULATOR_DECLINE_ABOVE
    ? Number(process.env.EMULATOR_DECLINE_ABOVE)
    : null,
};

const emulator = new ProviderEmulator(
  {
    shopId: process.env.PROVIDER_SHOP_ID ?? "food-delivery-shop",
    secretKey: process.env.PROVIDER_SECRET_KEY ?? "test_provider_dev_secret",
  },
  settings,
);

const port = Number(process.env.EMULATOR_PORT ?? 3010);

void startEmulatorServer(emulator, port, logger).then(() =>
  logger.info("эмулятор платёжного провайдера запущен", { port, settings }),
);
