import type { MenuItem, MenuOptionGroup } from "../api/queries";

/**
 * Выбор модификаторов блюда (CAT-3).
 *
 * Правила повторяют серверные: обязательную группу нельзя пропустить,
 * в группе «один из» выбирается ровно один вариант, в группе «несколько»
 * — не больше допустимого. Проверка в браузере нужна для подсказки
 * клиенту; окончательно выбор проверяет каталог при оформлении.
 */

/** Группа → выбранные варианты. */
export type Choice = Record<string, string[]>;

/** Начальный выбор: в обязательной группе «один из» сразу отмечен первый доступный вариант. */
export function initialChoice(item: MenuItem): Choice {
  const choice: Choice = {};
  for (const group of item.optionGroups) {
    const first = group.options.find((option) => option.isAvailable);
    choice[group.id] =
      group.selectionType === "single" && group.isRequired && first ? [first.id] : [];
  }
  return choice;
}

/** Нажатие на вариант: в «один из» заменяет выбор, в «несколько» — переключает. */
export function toggle(choice: Choice, group: MenuOptionGroup, optionId: string): Choice {
  const current = choice[group.id] ?? [];
  if (group.selectionType === "single") {
    const next = current[0] === optionId && !group.isRequired ? [] : [optionId];
    return { ...choice, [group.id]: next };
  }
  if (current.includes(optionId)) {
    return { ...choice, [group.id]: current.filter((id) => id !== optionId) };
  }
  if (current.length >= group.maxSelect) return choice;
  return { ...choice, [group.id]: [...current, optionId] };
}

/** Что мешает добавить блюдо — по группе, для подсказки рядом с ней. */
export function problems(item: MenuItem, choice: Choice): Record<string, string> {
  const result: Record<string, string> = {};
  for (const group of item.optionGroups) {
    const selected = (choice[group.id] ?? []).length;
    const min = group.isRequired ? Math.max(1, group.minSelect) : group.minSelect;
    if (selected < min) {
      result[group.id] =
        group.selectionType === "single" ? "выберите вариант" : `выберите хотя бы ${min}`;
    } else if (selected > group.maxSelect) {
      result[group.id] = `не больше ${group.maxSelect}`;
    }
  }
  return result;
}

/** Цена за штуку с выбранными модификаторами, копейки. */
export function unitPrice(item: MenuItem, choice: Choice): number {
  let price = item.price;
  for (const group of item.optionGroups) {
    for (const option of group.options) {
      if ((choice[group.id] ?? []).includes(option.id)) price += option.priceDelta;
    }
  }
  return price;
}

/** Выбор в виде, который принимает сервер, и названия вариантов для корзины. */
export function toSelections(item: MenuItem, choice: Choice) {
  const selections = item.optionGroups
    .map((group) => ({ groupId: group.id, optionIds: choice[group.id] ?? [] }))
    .filter((selection) => selection.optionIds.length > 0);
  const optionNames = item.optionGroups.flatMap((group) =>
    group.options
      .filter((option) => (choice[group.id] ?? []).includes(option.id))
      .map((option) => option.name),
  );
  return { selections, optionNames };
}

/**
 * Самая низкая цена блюда — для подписи «от …» в меню: обязательные
 * группы с самым дешёвым вариантом, необязательные — без выбора.
 */
export function minPrice(item: MenuItem): number {
  let price = item.price;
  for (const group of item.optionGroups) {
    if (!group.isRequired) continue;
    const deltas = group.options
      .filter((option) => option.isAvailable)
      .map((option) => option.priceDelta)
      .sort((a, b) => a - b);
    const take = Math.max(1, group.minSelect);
    price += deltas.slice(0, take).reduce((sum, delta) => sum + delta, 0);
  }
  return price;
}
