import { join } from "node:path";
import { Module } from "@nestjs/common";
import { GraphQLModule } from "@nestjs/graphql";
import { ApolloDriver, type ApolloDriverConfig } from "@nestjs/apollo";
import { AuthModule, ServiceKitModule } from "@food-delivery/service-kit";
import { getCorrelationId, isAppError } from "@food-delivery/shared";
import { GATEWAY_CONFIG, loadConfig } from "./config/configuration";
import { AuthController } from "./auth/auth.controller";
import { KeycloakClient } from "./auth/keycloak.client";
import { LoginRateLimiter } from "./auth/login-rate-limiter";
import { ACCOUNT_DIRECTORY, KeycloakAdminClient } from "./auth/keycloak-admin.client";
import { RegistrationService } from "./auth/registration.service";
import { CatalogCache } from "./catalog/catalog.cache";
import { CatalogClient } from "./catalog/catalog.client";
import { CatalogEventsConsumer } from "./catalog/catalog-events.consumer";
import { CatalogResolver } from "./graphql/catalog.resolver";
import { ManagerResolver } from "./graphql/manager.resolver";
import { OrderResolver } from "./graphql/order.resolver";
import { OrderClient } from "./order/order.client";
import { GqlAuthGuard } from "./graphql/gql-auth.guard";

/**
 * Создано по образцу сервиса catalog.
 *
 * У шлюза нет собственной базы: он не владеет данными, а перенаправляет
 * и агрегирует запросы к сервисам. Поэтому и проверок готовности нет —
 * добавлять сюда зависимость от доступности соседей не следует: иначе
 * отказ одного сервиса выведет из строя вход в систему целиком (REL-2).
 */
const config = loadConfig();

@Module({
  imports: [
    ServiceKitModule.forRoot({
      serviceName: "gateway",
    }),
    // Проверка токена на каждом запросе (SEC-2). Вход при этом остаётся
    // открытым — иначе войти было бы невозможно.
    // Секрет служебного приложения сюда не передаётся: проверке токенов он не нужен.
    AuthModule.forRoot({
      issuer: config.auth.issuer,
      providerUrl: config.auth.providerUrl,
      audience: config.auth.audience,
      disabled: config.auth.disabled,
      guard: GqlAuthGuard,
    }),
    GraphQLModule.forRoot<ApolloDriverConfig>({
      driver: ApolloDriver,
      // Схема создаётся из классов при запуске и сохраняется файлом:
      // он и есть контракт с клиентскими приложениями, который идёт
      // в отчёт и не может разойтись с кодом (MNT-3).
      autoSchemaFile: join(process.cwd(), "apps/gateway/schema.gql"),
      sortSchema: true,
      // Страница для ручных запросов: нужна на защите и при разработке,
      // в рабочем окружении лишняя.
      playground: config.nodeEnv !== "production",
      context: ({ req }: { req: unknown }) => ({ req }),
      formatError: (formatted, error) => {
        const original = (error as { originalError?: unknown })?.originalError;

        // Ошибка приложения — это сообщение пользователю: текст и код
        // передаются как есть.
        if (isAppError(original)) {
          return {
            message: original.message,
            extensions: {
              code: original.code,
              details: original.details,
              correlationId: getCorrelationId(),
            },
          };
        }

        // Всё остальное — сбой: наружу уходит общее сообщение, подробности
        // остаются в журнале. Разбор запроса самим GraphQL сюда не попадает:
        // у таких ошибок свой код, и их текст пользователю полезен.
        const code = formatted.extensions?.code;
        const isClientMistake = code === "GRAPHQL_VALIDATION_FAILED" || code === "BAD_USER_INPUT";

        return {
          message: isClientMistake ? formatted.message : "внутренняя ошибка шлюза",
          extensions: { code: code ?? "INTERNAL", correlationId: getCorrelationId() },
        };
      },
    }),
  ],
  controllers: [AuthController],
  providers: [
    { provide: GATEWAY_CONFIG, useValue: config },
    KeycloakClient,
    LoginRateLimiter,
    { provide: ACCOUNT_DIRECTORY, useClass: KeycloakAdminClient },
    RegistrationService,
    CatalogClient,
    CatalogCache,
    // Сброс кэша по событиям каталога — вторая половина требования CAT-4.
    CatalogEventsConsumer,
    CatalogResolver,
    ManagerResolver,
    OrderClient,
    OrderResolver,
  ],
})
export class AppModule {}
