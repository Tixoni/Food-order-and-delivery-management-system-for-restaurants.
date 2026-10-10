import { useState } from "react";
import { Link, Navigate } from "react-router-dom";
import { call, useSession } from "../auth/session";

/**
 * Регистрация клиента (AUTH-1).
 *
 * Учётная запись создаётся сразу, но войти в неё можно только после
 * перехода по ссылке из письма. Ответ на занятый адрес такой же, как на
 * свободный, — «письмо отправлено»: форма не должна подсказывать, кто
 * уже пользуется сервисом. Сотрудников здесь не заводят: регистрация
 * всегда выдаёт роль клиента, остальных добавляет администратор.
 */
export function RegisterPage() {
  const { user } = useSession();
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentTo, setSentTo] = useState<string | null>(null);

  if (user) return <Navigate to="/" replace />;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await call<{ email: string }>("/auth/register", {
        email: email.trim(),
        name: name.trim() || undefined,
        password,
      });
      setSentTo(result.email);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "не удалось зарегистрироваться");
    } finally {
      setBusy(false);
    }
  };

  if (sentTo) {
    return (
      <main className="page page--narrow">
        <h1 className="page__title">Проверьте почту</h1>
        <div className="card">
          <p>
            Мы отправили письмо на <strong>{sentTo}</strong>. Перейдите по ссылке из письма — после
            этого можно войти.
          </p>
          <p className="item__note">
            Письма нет? Проверьте папку «Спам» или запросите его ещё раз со страницы входа.
          </p>
          <p>
            <Link to="/login">Перейти ко входу</Link>
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="page page--narrow">
      <h1 className="page__title">Регистрация</h1>
      <p className="page__hint">Нужна, чтобы оформлять заказы и следить за доставкой.</p>

      <form className="card form" onSubmit={submit}>
        <div className="field">
          <label className="field__label" htmlFor="email">
            E-mail
          </label>
          <input
            id="email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            required
          />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="name">
            Как к вам обращаться
          </label>
          <input
            id="name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="given-name"
            maxLength={100}
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
            autoComplete="new-password"
            minLength={8}
            required
          />
          <span className="item__note">Не меньше 8 символов и не совпадает с e-mail</span>
        </div>
        {error && (
          <p className="notice notice--error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" disabled={busy || !email || password.length < 8}>
          {busy ? "Отправляем…" : "Зарегистрироваться"}
        </button>
      </form>

      <p className="page__hint">
        Уже есть учётная запись? <Link to="/login">Войти</Link>
      </p>
    </main>
  );
}
