import {
  type DynamicModule,
  MiddlewareConsumer,
  Module,
  type NestModule,
  Provider,
} from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { AppExceptionFilter } from "./app-exception.filter";
import { CorrelationMiddleware } from "./correlation.middleware";
import { HealthController, MetricsController } from "./kit.controllers";
import { MetricsService } from "./metrics.service";
import { READINESS_CHECKS, SERVICE_NAME } from "./readiness";

export interface ServiceKitOptions {
  serviceName: string;
  /** Классы проверок готовности. Сервис объявляет только то, без чего не работает. */
  readinessChecks?: Provider[];
  readinessTokens?: unknown[];
}

/**
 * Общий каркас сервиса. Подключается одной строкой и приносит:
 * проверки /health и /ready, отдачу метрик, сквозной идентификатор запроса.
 *
 * Вынесено в отдельный пакет, чтобы не повторять одно и то же в пяти сервисах:
 * исправление здесь распространяется на все сразу.
 */
@Module({})
export class ServiceKitModule implements NestModule {
  static forRoot(options: ServiceKitOptions): DynamicModule {
    const checkProviders = options.readinessChecks ?? [];
    const checkTokens = options.readinessTokens ?? [];

    return {
      module: ServiceKitModule,
      global: true,
      controllers: [HealthController, MetricsController],
      providers: [
        { provide: SERVICE_NAME, useValue: options.serviceName },
        MetricsService,
        // Перевод ошибок приложения в ответы клиенту. Регистрируется здесь,
        // чтобы каждый сервис не подключал его отдельно и не забыл это сделать.
        { provide: APP_FILTER, useClass: AppExceptionFilter },
        ...checkProviders,
        {
          provide: READINESS_CHECKS,
          useFactory: (...checks: unknown[]) => checks,
          inject: checkTokens as never[],
        },
      ],
      exports: [MetricsService, SERVICE_NAME],
    };
  }

  configure(consumer: MiddlewareConsumer) {
    consumer.apply(CorrelationMiddleware).forRoutes("*");
  }
}
