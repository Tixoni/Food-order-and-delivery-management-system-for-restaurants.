import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { createLogger, isAppError } from "@food-delivery/shared";
import { AppModule } from "./app.module";
import { loadConfig } from "./config/configuration";

const config = loadConfig();
const logger = createLogger({ service: "catalog", level: config.logLevel });

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();

  await app.listen(config.port, "0.0.0.0");
  logger.info("сервис каталога запущен", {
    port: config.port,
    env: config.nodeEnv,
    database: config.database.database,
  });
}

bootstrap().catch((error) => {
  logger.error("сервис не смог запуститься", error, {
    code: isAppError(error) ? error.code : undefined,
  });
  // Именно process.exitCode, а не process.exit(1): на Windows запись в поток
  // вывода асинхронна, и немедленный выход обрывает её. Процесс завершится сам,
  // когда опустеет очередь событий, — и сообщение об ошибке успеет напечататься.
  process.exitCode = 1;
});
