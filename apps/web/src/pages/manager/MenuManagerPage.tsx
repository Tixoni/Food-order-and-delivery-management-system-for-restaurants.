import { useState } from "react";
import { useMutation, useQuery } from "@apollo/client";
import { errorText } from "../../api/client";
import {
  MENU,
  MENU_CATEGORIES,
  REMOVE_MENU_ITEM,
  SAVE_CATEGORY,
  SET_AVAILABILITY,
  STOP_LIST,
  type MenuCategory,
  type MenuItem,
  type MenuSection,
  type StopListEntry,
} from "../../api/queries";
import { useSession } from "../../auth/session";
import { formatMoney } from "../../components/money";
import { DishForm } from "./DishForm";
import { ModifiersEditor } from "./ModifiersEditor";
import { useManagedRestaurant } from "./useManagedRestaurant";

type Editing = { kind: "dish"; item?: MenuItem } | { kind: "modifiers"; item: MenuItem } | null;

const time = (value: string) =>
  new Date(value).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" });

/**
 * Панель ресторана: меню, модификаторы, стоп-лист (CAT-3, CAT-4, CAT-5).
 *
 * Менеджер видит и блюда из стоп-листа — ему нужно вернуть их в продажу.
 * Кухня может только убрать блюдо в стоп-лист и вернуть: правка меню —
 * дело менеджера. Оба ограничения повторяют проверки сервера, а не
 * заменяют их (SEC-2).
 */
export function MenuManagerPage() {
  const { hasRole } = useSession();
  const canEdit = hasRole("manager", "admin");
  const { restaurantId, picker, missing } = useManagedRestaurant();
  const [editing, setEditing] = useState<Editing>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const [newCategory, setNewCategory] = useState("");

  const variables = { restaurantId: restaurantId ?? "", includeUnavailable: true };
  const menu = useQuery<{ menu: { categories: MenuSection[] } }>(MENU, {
    variables,
    skip: !restaurantId,
  });
  const categories = useQuery<{ menuCategories: MenuCategory[] }>(MENU_CATEGORIES, {
    variables: { restaurantId },
    skip: !restaurantId || !canEdit,
  });
  const stopList = useQuery<{ stopList: StopListEntry[] }>(STOP_LIST, {
    variables: { restaurantId },
    skip: !restaurantId,
  });

  const refetch = [
    { query: MENU, variables },
    { query: STOP_LIST, variables: { restaurantId } },
  ];
  const [setAvailability, availability] = useMutation(SET_AVAILABILITY, {
    refetchQueries: refetch,
  });
  const [removeItem] = useMutation(REMOVE_MENU_ITEM, { refetchQueries: refetch });
  const [saveCategory, savingCategory] = useMutation(SAVE_CATEGORY, {
    refetchQueries: [{ query: MENU_CATEGORIES, variables: { restaurantId } }, ...refetch],
  });

  if (missing) return <main className="page">{missing}</main>;

  const report = async (action: () => Promise<unknown>, ok: string) => {
    setMessage(null);
    try {
      await action();
      setMessage({ ok: true, text: ok });
    } catch (failure) {
      setMessage({ ok: false, text: errorText(failure) });
    }
  };

  /** CAT-4: убрать в стоп-лист с причиной или вернуть в продажу. */
  const toggle = (item: MenuItem) => {
    if (!restaurantId) return;
    if (item.isAvailable) {
      const reason = window.prompt(`Почему «${item.name}» нельзя заказать? (необязательно)`, "");
      if (reason === null) return;
      void report(
        () =>
          setAvailability({
            variables: {
              itemId: item.id,
              restaurantId,
              isAvailable: false,
              reason: reason.trim() || null,
            },
          }),
        `«${item.name}» убрано из продажи — клиенты перестанут его видеть через несколько секунд`,
      );
    } else {
      void report(
        () => setAvailability({ variables: { itemId: item.id, restaurantId, isAvailable: true } }),
        `«${item.name}» снова в продаже`,
      );
    }
  };

  const remove = (item: MenuItem) => {
    if (!restaurantId) return;
    if (!window.confirm(`Убрать «${item.name}» из меню? История заказов сохранится.`)) return;
    void report(
      () => removeItem({ variables: { itemId: item.id, restaurantId } }),
      `«${item.name}» убрано из меню`,
    );
  };

  const addCategory = (event: React.FormEvent) => {
    event.preventDefault();
    if (!restaurantId || !newCategory.trim()) return;
    void report(
      () => saveCategory({ variables: { input: { restaurantId, name: newCategory.trim() } } }),
      `Категория «${newCategory.trim()}» создана`,
    ).then(() => setNewCategory(""));
  };

  const sections = menu.data?.menu.categories ?? [];
  const allCategories = categories.data?.menuCategories ?? [];
  const names = new Map(sections.flatMap((s) => s.items).map((item) => [item.id, item.name]));

  return (
    <main className="page">
      <h1 className="page__title">Меню ресторана</h1>
      <p className="page__hint">
        Стоп-лист действует сразу: блюдо пропадает из витрины клиента за несколько секунд.
      </p>
      {picker}
      {message && (
        <p className={`notice ${message.ok ? "notice--ok" : "notice--error"}`} role="status">
          {message.text}
        </p>
      )}

      {canEdit && restaurantId && editing?.kind === "dish" && (
        <DishForm
          restaurantId={restaurantId}
          categories={allCategories}
          {...(editing.item ? { item: editing.item } : {})}
          onDone={() => setEditing(null)}
        />
      )}
      {canEdit && restaurantId && editing?.kind === "modifiers" && (
        <ModifiersEditor
          item={editing.item}
          restaurantId={restaurantId}
          onDone={() => setEditing(null)}
        />
      )}

      {canEdit && !editing && (
        <div className="card form">
          <div className="row">
            <button type="button" onClick={() => setEditing({ kind: "dish" })}>
              + Блюдо
            </button>
          </div>
          <form className="row" onSubmit={addCategory}>
            <div className="field">
              <label className="field__label" htmlFor="new-category">
                Новая категория
              </label>
              <input
                id="new-category"
                value={newCategory}
                onChange={(event) => setNewCategory(event.target.value)}
                placeholder="Супы, десерты…"
              />
            </div>
            <button type="submit" className="secondary" disabled={savingCategory.loading}>
              Добавить
            </button>
          </form>
          {allCategories.length > 0 && (
            <div className="chips">
              {allCategories.map((category) => (
                <button
                  key={category.id}
                  type="button"
                  className={`chip${category.isActive ? "" : " chip--muted"}`}
                  title={category.isActive ? "Скрыть категорию" : "Показать категорию"}
                  onClick={() =>
                    void report(
                      () =>
                        saveCategory({
                          variables: {
                            input: {
                              id: category.id,
                              restaurantId,
                              isActive: !category.isActive,
                            },
                          },
                        }),
                      category.isActive
                        ? `Категория «${category.name}» скрыта из меню`
                        : `Категория «${category.name}» снова в меню`,
                    )
                  }
                >
                  {category.name}
                  {category.isActive ? "" : " · скрыта"}
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {menu.loading && !menu.data && <p className="notice notice--quiet">Загружаем меню…</p>}
      {menu.error && <p className="notice notice--error">{errorText(menu.error)}</p>}

      {sections.map((section) => (
        <section key={section.id}>
          <h2 className="section__title">{section.name}</h2>
          {section.items.map((item) => (
            <article key={item.id} className={`item${item.isAvailable ? "" : " item--stopped"}`}>
              <div className="item__body">
                <div className="item__name">
                  {item.name}{" "}
                  <span className={`badge ${item.isAvailable ? "badge--ok" : "badge--stopped"}`}>
                    {item.isAvailable ? "в продаже" : "стоп-лист"}
                  </span>
                </div>
                <div className="item__note">
                  {formatMoney(item.price)}
                  {item.optionGroups.length > 0 &&
                    ` · модификаторы: ${item.optionGroups.map((g) => g.name).join(", ")}`}
                </div>
              </div>
              <div className="item__aside">
                <button
                  type="button"
                  className={item.isAvailable ? "secondary small" : "small"}
                  disabled={availability.loading}
                  onClick={() => toggle(item)}
                >
                  {item.isAvailable ? "В стоп-лист" : "Вернуть в продажу"}
                </button>
                {canEdit && (
                  <>
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => setEditing({ kind: "dish", item })}
                    >
                      Изменить
                    </button>
                    <button
                      type="button"
                      className="secondary small"
                      onClick={() => setEditing({ kind: "modifiers", item })}
                    >
                      Модификаторы
                    </button>
                    <button type="button" className="secondary small" onClick={() => remove(item)}>
                      Удалить
                    </button>
                  </>
                )}
              </div>
            </article>
          ))}
        </section>
      ))}

      <h2 className="section__title">Журнал стоп-листа</h2>
      {stopList.data && stopList.data.stopList.length === 0 && (
        <p className="notice notice--quiet">Блюда в стоп-лист ещё не попадали.</p>
      )}
      {stopList.data && stopList.data.stopList.length > 0 && (
        <table className="log">
          <thead>
            <tr>
              <th>Блюдо</th>
              <th>Убрано</th>
              <th>Вернули</th>
              <th>Причина</th>
            </tr>
          </thead>
          <tbody>
            {stopList.data.stopList.map((entry) => (
              <tr key={entry.id}>
                <td data-label="Блюдо">{names.get(entry.menuItemId) ?? "удалённое блюдо"}</td>
                <td data-label="Убрано">{time(entry.stoppedAt)}</td>
                <td data-label="Вернули">
                  {entry.restoredAt
                    ? `${time(entry.restoredAt)} · ${entry.outageMinutes} мин`
                    : "ещё в стоп-листе"}
                </td>
                <td data-label="Причина">{entry.reason ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
