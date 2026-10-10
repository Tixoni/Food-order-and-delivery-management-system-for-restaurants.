import { Suspense, lazy } from "react";
import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { useSession } from "./auth/session";
import { StorefrontPage } from "./pages/StorefrontPage";
import { RestaurantMenuPage } from "./pages/RestaurantMenuPage";
import { LoginPage } from "./pages/LoginPage";

/*
 * Разделы сотрудников загружаются отдельно, по требованию: клиенту
 * на телефоне незачем скачивать библиотеку карт и редакторы панели
 * ресторана, чтобы выбрать пиццу.
 */
const MenuManagerPage = lazy(() =>
  import("./pages/manager/MenuManagerPage").then((m) => ({ default: m.MenuManagerPage })),
);
const ZoneEditorPage = lazy(() =>
  import("./pages/manager/ZoneEditorPage").then((m) => ({ default: m.ZoneEditorPage })),
);
const AdminRestaurantsPage = lazy(() =>
  import("./pages/manager/AdminRestaurantsPage").then((m) => ({
    default: m.AdminRestaurantsPage,
  })),
);

/**
 * Разделы приложения.
 *
 * Витрина открыта всем: выбирать еду клиент должен до того, как заводить
 * учётную запись. Разделы сотрудников закрыты — но закрыты они здесь
 * только для удобства: пункт меню, которого не видно, всё равно можно
 * открыть по прямой ссылке, поэтому каждое действие проверяется
 * на сервере (SEC-2).
 */

function RequireRole({ roles, children }: { roles: string[]; children: JSX.Element }) {
  const { user, loading, hasRole } = useSession();

  if (loading) {
    return (
      <main className="page">
        <p className="notice notice--quiet">Проверяем, кто вы…</p>
      </main>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  if (!hasRole(...roles)) {
    return (
      <main className="page">
        <p className="notice notice--error">Этот раздел доступен другим сотрудникам.</p>
      </main>
    );
  }

  return (
    <Suspense
      fallback={
        <main className="page">
          <p className="notice notice--quiet">Загружаем раздел…</p>
        </main>
      }
    >
      {children}
    </Suspense>
  );
}

function Header() {
  const { user, logout, hasRole } = useSession();

  return (
    <header className="header">
      <NavLink to="/" className="header__brand">
        Доставка еды
      </NavLink>

      <nav className="header__nav">
        <NavLink to="/">Витрина</NavLink>

        {hasRole("manager", "kitchen", "admin") && <NavLink to="/manage/menu">Меню</NavLink>}
        {hasRole("manager", "admin") && <NavLink to="/manage/zone">Зона доставки</NavLink>}
        {hasRole("admin") && <NavLink to="/admin/restaurants">Рестораны</NavLink>}

        {user ? (
          <>
            <span className="header__user">{user.name ?? user.email}</span>
            <button type="button" className="secondary small" onClick={() => void logout()}>
              Выйти
            </button>
          </>
        ) : (
          <NavLink to="/login">Войти</NavLink>
        )}
      </nav>
    </header>
  );
}

export function App() {
  return (
    <>
      <Header />

      <Routes>
        <Route path="/" element={<StorefrontPage />} />
        <Route path="/restaurants/:restaurantId" element={<RestaurantMenuPage />} />
        <Route path="/login" element={<LoginPage />} />

        <Route
          path="/manage/menu"
          element={
            <RequireRole roles={["manager", "kitchen", "admin"]}>
              <MenuManagerPage />
            </RequireRole>
          }
        />
        <Route
          path="/manage/zone"
          element={
            <RequireRole roles={["manager", "admin"]}>
              <ZoneEditorPage />
            </RequireRole>
          }
        />
        <Route
          path="/admin/restaurants"
          element={
            <RequireRole roles={["admin"]}>
              <AdminRestaurantsPage />
            </RequireRole>
          }
        />

        <Route
          path="*"
          element={
            <main className="page">
              <p className="notice notice--quiet">Такой страницы нет.</p>
            </main>
          }
        />
      </Routes>
    </>
  );
}
