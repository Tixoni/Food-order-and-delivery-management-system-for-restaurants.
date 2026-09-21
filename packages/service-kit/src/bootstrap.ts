import { NestFactory } from "@nestjs/core";
import { createLogger, isAppError, type LogLevel } from "@food-delivery/shared";

export interface BootstrapOptions {
  serviceName: string;
  port: number;
  logLevel?: LogLevel;
  nodeEnv?: string;
}

/**
 * Единый запуск для всех сервисов.
 *
 * Обратите внимание на process.exitCode вместо process.exit: на Windows
 * запись в поток вывода асинхронна, и немедленный выход обрывает её —
 * сервис падал бы молча, не оставляя следов причины.
 */
export async function bootstrapService(
  appModule: unknown,
  options: BootstrapOptions,
): Promise<void> {
  const logger = createLogger({
    service: options.serviceName,
    level: options.logLevel ?? "info",
  });

  try {
    const app = await NestFactory.create(appModule as never, { logger: false });
    app.enableShutdownHooks();
    await app.listen(options.port, "0.0.0.0");

    logger.info("сервис запущен", {
      port: options.port,
      env: options.nodeEnv ?? process.env.NODE_ENV ?? "development",
    });
  } catch (error) {
    logger.error("сервис не смог запуститься", error, {
      code: isAppError(error) ? error.code : undefined,
    });
    process.exitCode = 1;
  }
}
