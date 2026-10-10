import { useEffect, useMemo, useRef, useState } from "react";
import type { MenuItem } from "../api/queries";
import { formatMoney } from "./money";
import { initialChoice, problems, toSelections, toggle, unitPrice, type Choice } from "./modifiers";

interface Props {
  item: MenuItem;
  onAdd: (line: {
    quantity: number;
    selections: Array<{ groupId: string; optionIds: string[] }>;
    optionNames: string[];
    unitPrice: number;
  }) => void;
  onClose: () => void;
}

/**
 * Карточка блюда: состав, модификаторы, количество, цена (CAT-2, CAT-3).
 *
 * Открывается встроенным модальным окном браузера (`<dialog>`): оно само
 * держит фокус внутри, закрывается клавишей Esc и объявляется программам
 * экранного доступа — писать это вручную незачем.
 */
export function ItemDialog({ item, onAdd, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [choice, setChoice] = useState<Choice>(() => initialChoice(item));
  const [quantity, setQuantity] = useState(1);

  // Закрывать окно при размонтировании не нужно: вместе с элементом
  // исчезает и модальность. Закрытие здесь ещё и вредно — в режиме
  // разработки React выполняет эффект дважды, и событие close от первой
  // очистки тут же закрыло бы только что открытое окно.
  useEffect(() => {
    const element = dialog.current;
    if (element && !element.open) element.showModal();
  }, []);

  const issues = useMemo(() => problems(item, choice), [item, choice]);
  const price = unitPrice(item, choice);
  const canAdd = Object.keys(issues).length === 0;

  const add = () => {
    if (!canAdd) return;
    onAdd({ quantity, unitPrice: price, ...toSelections(item, choice) });
  };

  return (
    <dialog
      ref={dialog}
      className="dialog"
      aria-labelledby="item-dialog-title"
      onClose={onClose}
      onClick={(event) => {
        // Нажатие на затемнённый фон вокруг окна закрывает его
        if (event.target === dialog.current) dialog.current?.close();
      }}
    >
      <div className="dialog__body">
        {item.imageUrl ? (
          <img className="dish-image dish-image--large" src={item.imageUrl} alt="" />
        ) : null}

        <h2 id="item-dialog-title" className="dialog__title">
          {item.name}
        </h2>
        {item.description && <p className="item__note">{item.description}</p>}
        {item.composition && <p className="item__note">Состав: {item.composition}</p>}
        <p className="item__note">
          {[
            item.weightGrams ? `${item.weightGrams} г` : null,
            item.calories ? `${item.calories} ккал` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>

        {item.optionGroups.map((group) => (
          <fieldset key={group.id} className="options">
            <legend className="options__title">
              {group.name}
              {group.isRequired && <span className="options__required"> · обязательно</span>}
              {group.selectionType === "multiple" && (
                <span className="options__hint"> · до {group.maxSelect}</span>
              )}
            </legend>
            {group.options.map((option) => {
              const checked = (choice[group.id] ?? []).includes(option.id);
              return (
                <label
                  key={option.id}
                  className={`option${option.isAvailable ? "" : " option--disabled"}`}
                >
                  <input
                    type={group.selectionType === "single" ? "radio" : "checkbox"}
                    name={group.id}
                    checked={checked}
                    disabled={!option.isAvailable}
                    onChange={() => setChoice((current) => toggle(current, group, option.id))}
                  />
                  <span className="option__name">
                    {option.name}
                    {!option.isAvailable && " — нет в наличии"}
                  </span>
                  {option.priceDelta !== 0 && (
                    <span className="price">
                      {option.priceDelta > 0 ? "+" : ""}
                      {formatMoney(option.priceDelta)}
                    </span>
                  )}
                </label>
              );
            })}
            {issues[group.id] && <p className="options__problem">{issues[group.id]}</p>}
          </fieldset>
        ))}
      </div>

      <div className="dialog__footer">
        <div className="stepper" role="group" aria-label="Количество">
          <button
            type="button"
            className="secondary small"
            aria-label="Меньше"
            disabled={quantity <= 1}
            onClick={() => setQuantity((value) => Math.max(1, value - 1))}
          >
            −
          </button>
          <span className="stepper__value" aria-live="polite">
            {quantity}
          </span>
          <button
            type="button"
            className="secondary small"
            aria-label="Больше"
            disabled={quantity >= 99}
            onClick={() => setQuantity((value) => Math.min(99, value + 1))}
          >
            +
          </button>
        </div>

        <button type="button" onClick={add} disabled={!canAdd}>
          Добавить · {formatMoney(price * quantity)}
        </button>
        <button type="button" className="secondary" onClick={() => dialog.current?.close()}>
          Закрыть
        </button>
      </div>
    </dialog>
  );
}
