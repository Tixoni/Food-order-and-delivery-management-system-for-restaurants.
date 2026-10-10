import { useState } from "react";
import { Navigate } from "react-router-dom";
import { useSession, type SessionUser } from "../auth/session";

/** Куда вести после входа: сотрудника — сразу в его раздел, клиента — на витрину. */
function homeOf(user: SessionUser): string {
  if (user.roles.includes("admin")) return "/admin/restaurants";
  if (user.roles.some((role) => role === "manager" || role === "kitchen")) return "/manage/menu";
  return "/";
}

/**
 * Вход в систему.
 *
 * Пароль уходит шлюзу, а от него — провайдеру входа (Keycloak); сама
 * система паролей не хранит (SEC-6). Ответ об ошибке намеренно общий:
 * «неверный логин или пароль», без уточнения, что именно не так, —
 * иначе форма помогала бы подбирать существующие учётные записи.
 */
export function LoginPage() {
  const { user, login, error } = useSession();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  if (user) return <Navigate to={homeOf(user)} replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      // Переход выполнит перерисовка: после входа пользователь уже в сеансе.
      await login(username.trim(), password);
    } catch {
      // Текст ошибки показывает сеанс
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="page page--narrow">
      <h1 className="page__title">Вход</h1>
      <p className="page__hint">
        Для заказа и для работы сотрудников ресторана. Выбирать блюда можно и без входа.
      </p>

      <form className="card form" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor="username">
            Логин или e-mail
          </label>
          <input
            id="username"
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            autoComplete="username"
            required
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="password">
            Пароль
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            autoComplete="current-password"
            required
          />
        </div>
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !username || !password}>
          {busy ? "Входим…" : "Войти"}
        </button>
      </form>
    </main>
  );
}
