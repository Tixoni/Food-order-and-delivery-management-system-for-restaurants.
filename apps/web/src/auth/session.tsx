import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

/**
 * Кто вошёл в приложение.
 *
 * Токен доступа держится в памяти и нигде больше. Это осознанный выбор,
 * а не упущение: токен, положенный в localStorage, доступен любому
 * сценарию на странице, и одной уязвимости вида XSS достаточно, чтобы
 * его унести. Долгоживущий refresh-token лежит в куке, закрытой для
 * сценариев, поэтому после перезагрузки вкладки приложение просто
 * просит шлюз выдать новый токен доступа (AUTH-4).
 *
 * Роли из токена используются только для показа разделов. Каждое
 * действие всё равно проверяется на сервере (SEC-2): проверка в браузере
 * защищает от неудобства, а не от злоумышленника.
 */

export interface SessionUser {
  id: string;
  email?: string;
  name?: string;
  roles: string[];
  restaurantId?: string;
}

/** Ошибка шлюза с причиной: по ней форма решает, что предложить пользователю. */
export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason?: string,
  ) {
    super(message);
  }
}

interface SessionState {
  user: SessionUser | null;
  /** Истина, пока приложение выясняет, есть ли действующий сеанс. */
  loading: boolean;
  error: string | null;
  /** Причина последней ошибки входа, например EMAIL_NOT_VERIFIED. */
  errorReason: string | null;
  login: (username: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  /** Токен для запросов. Функция, а не значение: он меняется при продлении. */
  accessToken: () => string | null;
  hasRole: (...roles: string[]) => boolean;
}

const SessionContext = createContext<SessionState | null>(null);

interface LoginResponse {
  accessToken: string;
  expiresIn: number;
  user: SessionUser;
}

export async function call<T = LoginResponse>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // Без этого браузер не отправит и не сохранит куку с refresh-token.
    credentials: "same-origin",
    body: JSON.stringify(body ?? {}),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new AuthError(payload.message ?? "не удалось войти", payload.details?.reason);
  }

  return payload as T;
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<SessionUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorReason, setErrorReason] = useState<string | null>(null);

  // Токен в ref, а не в состоянии: его изменение не должно перерисовывать
  // приложение, а читать его нужно из обработчиков запросов.
  const token = useRef<string | null>(null);
  const renewal = useRef<number | null>(null);

  const apply = useCallback((session: LoginResponse) => {
    token.current = session.accessToken;
    setUser(session.user);
    setError(null);
    setErrorReason(null);

    // Продление заранее, за минуту до конца: иначе запрос, отправленный
    // в последнюю секунду, придёт на сервер уже с истёкшим токеном.
    if (renewal.current) window.clearTimeout(renewal.current);
    renewal.current = window.setTimeout(
      () => {
        void call<LoginResponse>("/auth/refresh").then(apply).catch(reset);
      },
      Math.max(5, session.expiresIn - 60) * 1000,
    );
  }, []);

  const reset = useCallback(() => {
    token.current = null;
    setUser(null);
    if (renewal.current) window.clearTimeout(renewal.current);
  }, []);

  // При запуске приложение проверяет, не остался ли действующий сеанс:
  // токен доступа перезагрузку вкладки не переживает, а кука — да.
  useEffect(() => {
    call<LoginResponse>("/auth/refresh")
      .then(apply)
      .catch(() => reset())
      .finally(() => setLoading(false));

    return () => {
      if (renewal.current) window.clearTimeout(renewal.current);
    };
  }, [apply, reset]);

  const login = useCallback(
    async (username: string, password: string) => {
      try {
        apply(await call<LoginResponse>("/auth/login", { username, password }));
      } catch (failure) {
        setError(failure instanceof Error ? failure.message : "не удалось войти");
        setErrorReason(failure instanceof AuthError ? (failure.reason ?? null) : null);
        throw failure;
      }
    },
    [apply],
  );

  const logout = useCallback(async () => {
    await call("/auth/logout").catch(() => undefined);
    reset();
  }, [reset]);

  const value = useMemo<SessionState>(
    () => ({
      user,
      loading,
      error,
      errorReason,
      login,
      logout,
      accessToken: () => token.current,
      hasRole: (...roles: string[]) => !!user && roles.some((role) => user.roles.includes(role)),
    }),
    [user, loading, error, errorReason, login, logout],
  );

  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionState {
  const session = useContext(SessionContext);
  if (!session) {
    throw new Error("useSession вызван вне SessionProvider");
  }
  return session;
}
