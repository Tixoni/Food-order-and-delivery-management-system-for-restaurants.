import { useState } from "react";
import { useMutation } from "@apollo/client";
import { errorText } from "../../api/client";
import { MENU, REPLACE_MODIFIERS, type MenuItem } from "../../api/queries";
import { moneyInput, parseSignedMoney } from "../../components/money";

interface DraftOption {
  name: string;
  priceDelta: string;
  isAvailable: boolean;
}

interface DraftGroup {
  name: string;
  selectionType: "single" | "multiple";
  isRequired: boolean;
  maxSelect: number;
  options: DraftOption[];
}

const toDraft = (item: MenuItem): DraftGroup[] =>
  item.optionGroups.map((group) => ({
    name: group.name,
    selectionType: group.selectionType,
    isRequired: group.isRequired,
    maxSelect: group.maxSelect,
    options: group.options.map((option) => ({
      name: option.name,
      priceDelta: moneyInput(option.priceDelta),
      isAvailable: option.isAvailable,
    })),
  }));

/**
 * Редактор модификаторов блюда (CAT-3): группы «один из» и «несколько»,
 * варианты с надбавкой к цене.
 *
 * Набор групп отправляется целиком и заменяет прежний — так не нужно
 * вычислять разницу между старым и новым на стороне браузера. Проверку
 * правил (непустая группа, допустимые границы выбора) выполняет каталог:
 * здесь — только подсказки при вводе.
 */
export function ModifiersEditor({
  item,
  restaurantId,
  onDone,
}: {
  item: MenuItem;
  restaurantId: string;
  onDone: () => void;
}) {
  const [groups, setGroups] = useState<DraftGroup[]>(() => toDraft(item));
  const [problem, setProblem] = useState<string | null>(null);
  const [save, saving] = useMutation(REPLACE_MODIFIERS, {
    refetchQueries: [{ query: MENU, variables: { restaurantId, includeUnavailable: true } }],
  });

  const updateGroup = (index: number, patch: Partial<DraftGroup>) =>
    setGroups((current) =>
      current.map((group, i) => (i === index ? { ...group, ...patch } : group)),
    );
  const updateOption = (groupIndex: number, optionIndex: number, patch: Partial<DraftOption>) =>
    updateGroup(groupIndex, {
      options: groups[groupIndex]!.options.map((option, i) =>
        i === optionIndex ? { ...option, ...patch } : option,
      ),
    });

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setProblem(null);
    const payload = [];
    for (const group of groups) {
      if (!group.name.trim()) return setProblem("У каждой группы должно быть название");
      if (group.options.length === 0) return setProblem(`В группе «${group.name}» нет вариантов`);
      const options = [];
      for (const option of group.options) {
        const delta = parseSignedMoney(option.priceDelta || "0");
        if (!option.name.trim())
          return setProblem(`В группе «${group.name}» есть вариант без названия`);
        if (delta === null) return setProblem(`Неверная надбавка у «${option.name}»`);
        options.push({
          name: option.name.trim(),
          priceDelta: delta,
          isAvailable: option.isAvailable,
        });
      }
      const single = group.selectionType === "single";
      payload.push({
        name: group.name.trim(),
        selectionType: group.selectionType,
        isRequired: group.isRequired,
        minSelect: group.isRequired ? 1 : 0,
        maxSelect: single ? 1 : Math.max(1, Math.min(group.maxSelect, options.length)),
        options,
      });
    }
    try {
      await save({ variables: { itemId: item.id, restaurantId, groups: payload } });
      onDone();
    } catch (failure) {
      setProblem(errorText(failure));
    }
  };

  return (
    <form className="card form editor" onSubmit={submit}>
      <h3 className="editor__title">Модификаторы: {item.name}</h3>
      {groups.length === 0 && <p className="item__note">У блюда нет модификаторов.</p>}

      {groups.map((group, groupIndex) => (
        <fieldset key={groupIndex} className="editor__group">
          <div className="row">
            <div className="field">
              <label className="field__label">Группа</label>
              <input
                value={group.name}
                onChange={(event) => updateGroup(groupIndex, { name: event.target.value })}
                placeholder="Размер, добавки…"
              />
            </div>
            <div className="field">
              <label className="field__label">Выбор</label>
              <select
                value={group.selectionType}
                onChange={(event) =>
                  updateGroup(groupIndex, {
                    selectionType: event.target.value as DraftGroup["selectionType"],
                  })
                }
              >
                <option value="single">один из</option>
                <option value="multiple">несколько</option>
              </select>
            </div>
            {group.selectionType === "multiple" && (
              <div className="field field--short">
                <label className="field__label">Не больше</label>
                <input
                  type="number"
                  min={1}
                  value={group.maxSelect}
                  onChange={(event) =>
                    updateGroup(groupIndex, { maxSelect: Number(event.target.value) || 1 })
                  }
                />
              </div>
            )}
            <label className="check">
              <input
                type="checkbox"
                checked={group.isRequired}
                onChange={(event) => updateGroup(groupIndex, { isRequired: event.target.checked })}
              />
              обязательно
            </label>
          </div>

          {group.options.map((option, optionIndex) => (
            <div key={optionIndex} className="row editor__option">
              <div className="field">
                <input
                  aria-label="Вариант"
                  value={option.name}
                  onChange={(event) =>
                    updateOption(groupIndex, optionIndex, { name: event.target.value })
                  }
                  placeholder="Вариант"
                />
              </div>
              <div className="field field--short">
                <input
                  aria-label="Надбавка, ₽"
                  inputMode="decimal"
                  value={option.priceDelta}
                  onChange={(event) =>
                    updateOption(groupIndex, optionIndex, { priceDelta: event.target.value })
                  }
                  placeholder="+ ₽"
                />
              </div>
              <label className="check">
                <input
                  type="checkbox"
                  checked={option.isAvailable}
                  onChange={(event) =>
                    updateOption(groupIndex, optionIndex, { isAvailable: event.target.checked })
                  }
                />
                в наличии
              </label>
              <button
                type="button"
                className="secondary small"
                onClick={() =>
                  updateGroup(groupIndex, {
                    options: group.options.filter((_, i) => i !== optionIndex),
                  })
                }
              >
                Убрать
              </button>
            </div>
          ))}

          <div className="row">
            <button
              type="button"
              className="secondary small"
              onClick={() =>
                updateGroup(groupIndex, {
                  options: [...group.options, { name: "", priceDelta: "0", isAvailable: true }],
                })
              }
            >
              + вариант
            </button>
            <button
              type="button"
              className="secondary small"
              onClick={() => setGroups((current) => current.filter((_, i) => i !== groupIndex))}
            >
              Удалить группу
            </button>
          </div>
        </fieldset>
      ))}

      <div className="row">
        <button
          type="button"
          className="secondary small"
          onClick={() =>
            setGroups((current) => [
              ...current,
              {
                name: "",
                selectionType: "single",
                isRequired: false,
                maxSelect: 1,
                options: [{ name: "", priceDelta: "0", isAvailable: true }],
              },
            ])
          }
        >
          + группа
        </button>
      </div>

      {problem && <p className="notice notice--error">{problem}</p>}
      <div className="row">
        <button type="submit" disabled={saving.loading}>
          {saving.loading ? "Сохраняем…" : "Сохранить модификаторы"}
        </button>
        <button type="button" className="secondary" onClick={onDone}>
          Отмена
        </button>
      </div>
    </form>
  );
}
