/**
 * Кто выполняет запрос.
 *
 * Роли перечислены явным списком, а не свободными строками: опечатка
 * в названии роли — это тихо выключенная проверка прав, и заметить её
 * без такого списка можно только по последствиям (AUTH-3, SEC-2).
 */
export const ROLES = {
  client: "client",
  manager: "manager",
  kitchen: "kitchen",
  courier: "courier",
  operator: "operator",
  admin: "admin",
} as const;

export type Role = (typeof ROLES)[keyof typeof ROLES];

export interface AuthenticatedUser {
  /** Идентификатор пользователя у провайдера входа. */
  readonly id: string;
  readonly email?: string;
  readonly name?: string;
  readonly roles: readonly Role[];
  /**
   * Ресторан, к которому привязан сотрудник: менеджер или кухня.
   * Именно по нему проверяется владение ресурсом — менеджер одного
   * ресторана не должен править меню другого (SEC-2).
   */
  readonly restaurantId?: string;
}

export function hasRole(user: AuthenticatedUser | undefined, ...roles: Role[]): boolean {
  return !!user && roles.some((role) => user.roles.includes(role));
}

/**
 * Набор обязательных полей токена OIDC, которыми пользуется система.
 * Остальные поля токена сознательно игнорируются — принцип толерантного
 * читателя: провайдер вправе добавлять свои поля.
 */
export interface TokenClaims {
  sub: string;
  email?: string;
  name?: string;
  preferred_username?: string;
  realm_access?: { roles?: string[] };
  restaurantId?: string;
  exp?: number;
  iat?: number;
}

/** Метка для внедрения настроек доступа. */
export const AUTH_OPTIONS = Symbol("AuthOptions");

export interface AuthOptions {
  /** Издатель токена — публичный адрес области провайдера входа (поле `iss`). */
  issuer: string;
  /**
   * Адрес той же области внутри сети сервисов, по которому забираются ключи
   * проверки подписи. Публичный адрес из контейнера может быть недоступен:
   * для браузера провайдер — `localhost:18080`, для сервиса — `keycloak:8080`.
   * Не задан — совпадает с издателем.
   */
  providerUrl?: string;
  /** Кому предназначен токен. Токен для другой системы принимать нельзя. */
  audience: string;
  /**
   * Выключает проверку подписи целиком. Нужно только для тестов и локальной
   * разработки без провайдера входа; в рабочем окружении недопустимо,
   * поэтому сервис пишет об этом предупреждение при запуске.
   */
  disabled?: boolean;
}
