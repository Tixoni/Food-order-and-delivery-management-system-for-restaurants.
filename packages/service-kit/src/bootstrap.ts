import type { Server } from "node:http";
import { NestFactory } from "@nestjs/core";
import { createLogger, isAppError, type LogLevel } from "@food-delivery/shared";
import { shutdownTracing } from "./tracing";

export interface BootstrapOptions {
  serviceName: string;
  port: number;
  logLevel?: LogLevel;
  nodeEnv?: string;
  /**
   * Сколько обратных прокси стоит перед сервисом. Адрес клиента (`req.ip`)
   * берётся из `X-Forwarded-For` ровно на столько звеньев справа — то, что
   * дописали наши прокси. Левее — то, что прислал сам клиент, и верить этому
   * нельзя. 0 — прокси нет, адрес — само соединение.
   */
  trustProxyHops?: number;
  /** Сколько ждать завершения начатых запросов при остановке. */
  drainTimeoutMs?: number;
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
    if (options.trustProxyHops) {
      app.getHttpAdapter().getInstance().set("trust proxy", options.trustProxyHops);
    }
    await app.listen(options.port, "0.0.0.0");

    // Начатые HTTP-запросы; подписки WebSocket сюда не входят — их
    // закрывает модуль GraphQL при остановке, и клиент переподключается.
    const server = app.getHttpServer() as Server;
    let active = 0;
    server.on("request", (_request, response) => {
      active += 1;
      response.on("close", () => (active -= 1));
    });

    /**
     * Штатная остановка за балансировщиком (SCAL-2).
     *
     * Порядок важен. Сначала сервис перестаёт принимать соединения и
     * закрывает простаивающие: прокси сразу получает отказ в соединении и
     * отправляет запрос на другую реплику. Начатые запросы дорабатывают —
     * база, Redis и брокер ещё подключены. Только потом гасятся модули.
     * Стандартный порядок Nest обратный (модули, последним — HTTP-сервер):
     * всё время остановки реплика принимала запросы, которые уже не могла
     * выполнить, — найдено проверкой двух реплик за прокси.
     */
    const stop = async (signal: NodeJS.Signals) => {
      logger.info("остановка: новые соединения не принимаются", { signal, active });
      server.close();
      server.closeIdleConnections();
      const deadline = Date.now() + (options.drainTimeoutMs ?? 5000);
      while (active > 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (active > 0) logger.warn("остановка: запросы не успели завершиться", { active });
      await app.close();
      await shutdownTracing();
      logger.info("сервис остановлен", { signal });
      // Обработчик уже снят (once): повторный сигнал завершит процесс, даже
      // если какой-то клиент оставил открытый дескриптор. Как в Nest.
      setTimeout(() => process.kill(process.pid, signal), 100).unref();
    };
    process.once("SIGTERM", () => void stop("SIGTERM"));
    process.once("SIGINT", () => void stop("SIGINT"));

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
