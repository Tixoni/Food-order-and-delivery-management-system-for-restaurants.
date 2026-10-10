import { useState } from "react";
import { useMutation } from "@apollo/client";
import { errorText } from "../../api/client";
import { MENU, SAVE_MENU_ITEM, type MenuCategory, type MenuItem } from "../../api/queries";
import { moneyInput, parseMoney } from "../../components/money";

interface Props {
  restaurantId: string;
  categories: MenuCategory[];
  /** Блюдо для правки; без него форма создаёт новое. */
  item?: MenuItem;
  onDone: () => void;
}

const optionalInt = (value: string): number | undefined => {
  if (value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : NaN;
};

/**
 * Создание и правка блюда (CAT-5).
 *
 * Цена вводится в рублях — так привычнее человеку, — а уходит на сервер
 * целыми копейками. Пустое поле означает «не менять», а не «обнулить».
 */
export function DishForm({ restaurantId, categories, item, onDone }: Props) {
  const [name, setName] = useState(item?.name ?? "");
  const [categoryId, setCategoryId] = useState(item?.categoryId ?? categories[0]?.id ?? "");
  const [price, setPrice] = useState(item ? moneyInput(item.price) : "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [composition, setComposition] = useState(item?.composition ?? "");
  const [imageUrl, setImageUrl] = useState(item?.imageUrl ?? "");
  const [weight, setWeight] = useState(item?.weightGrams ? String(item.weightGrams) : "");
  const [calories, setCalories] = useState(item?.calories ? String(item.calories) : "");
  const [problem, setProblem] = useState<string | null>(null);

  const [save, saving] = useMutation(SAVE_MENU_ITEM, {
    refetchQueries: [{ query: MENU, variables: { restaurantId, includeUnavailable: true } }],
  });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const kopecks = parseMoney(price);
    const weightGrams = optionalInt(weight);
    const kcal = optionalInt(calories);
    if (!name.trim()) return setProblem("Укажите название");
    if (kopecks === null) return setProblem("Цена — число в рублях, например 390 или 390,50");
    if (Number.isNaN(weightGrams) || Number.isNaN(kcal)) {
      return setProblem("Вес и калорийность — целые неотрицательные числа");
    }
    if (!item && !categoryId) return setProblem("Сначала создайте категорию меню");

    try {
      await save({
        variables: {
          input: {
            ...(item ? { id: item.id } : {}),
            restaurantId,
            categoryId,
            name: name.trim(),
            price: kopecks,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(composition.trim() ? { composition: composition.trim() } : {}),
            ...(imageUrl.trim() ? { imageUrl: imageUrl.trim() } : {}),
            ...(weightGrams !== undefined ? { weightGrams } : {}),
            ...(kcal !== undefined ? { calories: kcal } : {}),
          },
        },
      });
      onDone();
    } catch (failure) {
      setProblem(errorText(failure));
    }
  };

  return (
    <form className="card form editor" onSubmit={submit}>
      <h3 className="editor__title">{item ? `Блюдо: ${item.name}` : "Новое блюдо"}</h3>
      <div className="row">
        <div className="field">
          <label className="field__label" htmlFor="dish-name">
            Название
          </label>
          <input id="dish-name" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="field">
          <label className="field__label" htmlFor="dish-category">
            Категория
          </label>
          <select
            id="dish-category"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
          >
            {categories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
                {category.isActive ? "" : " (скрыта)"}
              </option>
            ))}
          </select>
        </div>
        <div className="field field--short">
          <label className="field__label" htmlFor="dish-price">
            Цена, ₽
          </label>
          <input
            id="dish-price"
            inputMode="decimal"
            value={price}
            onChange={(event) => setPrice(event.target.value)}
          />
        </div>
      </div>
      <div className="field">
        <label className="field__label" htmlFor="dish-description">
          Описание
        </label>
        <textarea
          id="dish-description"
          rows={2}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </div>
      <div className="field">
        <label className="field__label" htmlFor="dish-composition">
          Состав — по нему ищут клиенты
        </label>
        <textarea
          id="dish-composition"
          rows={2}
          value={composition}
          onChange={(event) => setComposition(event.target.value)}
        />
      </div>
      <div className="row">
        <div className="field">
          <label className="field__label" htmlFor="dish-image">
            Ссылка на фотографию
          </label>
          <input
            id="dish-image"
            type="url"
            value={imageUrl}
            onChange={(event) => setImageUrl(event.target.value)}
            placeholder="https://…"
          />
        </div>
        <div className="field field--short">
          <label className="field__label" htmlFor="dish-weight">
            Вес, г
          </label>
          <input
            id="dish-weight"
            inputMode="numeric"
            value={weight}
            onChange={(event) => setWeight(event.target.value)}
          />
        </div>
        <div className="field field--short">
          <label className="field__label" htmlFor="dish-calories">
            Ккал
          </label>
          <input
            id="dish-calories"
            inputMode="numeric"
            value={calories}
            onChange={(event) => setCalories(event.target.value)}
          />
        </div>
      </div>
      {problem && <p className="notice notice--error">{problem}</p>}
      <div className="row">
        <button type="submit" disabled={saving.loading}>
          {saving.loading ? "Сохраняем…" : "Сохранить"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Отмена
        </button>
      </div>
    </form>
  );
}
