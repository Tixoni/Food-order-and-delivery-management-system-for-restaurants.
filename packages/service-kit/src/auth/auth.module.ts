import { type CanActivate, type DynamicModule, Module, type Type } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthGuard } from "./auth.guard";
import { TokenVerifier } from "./token-verifier";
import { AUTH_OPTIONS, type AuthOptions } from "./auth.types";

/**
 * Проверка входа и ролей для сервиса.
 *
 * Подключается одной строкой и закрывает все обработчики сразу:
 * сторож регистрируется как общий для приложения, а не навешивается
 * на каждый метод руками. Пропущенный метод — это открытые наружу
 * чужие данные, и полагаться здесь на внимательность нельзя (SEC-2).
 */
@Module({})
export class AuthModule {
  /**
   * Сторож можно заменить наследником: шлюзу нужен тот же набор правил,
   * но запрос он достаёт из контекста GraphQL. Правила при этом остаются
   * одни — наследуются, а не переписываются.
   */
  static forRoot(options: AuthOptions & { guard?: Type<CanActivate> }): DynamicModule {
    return {
      module: AuthModule,
      global: true,
      providers: [
        { provide: AUTH_OPTIONS, useValue: options },
        TokenVerifier,
        { provide: APP_GUARD, useClass: options.guard ?? AuthGuard },
      ],
      exports: [TokenVerifier, AUTH_OPTIONS],
    };
  }
}
