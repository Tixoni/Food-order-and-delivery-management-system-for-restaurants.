import type { MenuSection } from "../../domain/menu-category";

/**
 * Кэш собранного меню.
 *
 * Меню читают несравнимо чаще, чем меняют: страница ресторана открывается
 * при каждом заходе клиента, а блюда правит менеджер несколько раз в день.
 * Без кэша каждый такой заход — три запроса к базе.
 *
 * Ключевое требование — CAT-4: изменение стоп-листа отражается в выдаче
 * не позднее пяти секунд. Поэтому кэш сбрасывается не по истечении времени
 * жизни, а сразу при изменении: срок жизни здесь — страховка на случай
 * потери события, а не основной механизм.
 *
 * Порт описан в терминах домена. То, что за ним Redis, знает только
 * инфраструктурный слой; в тестах подставляется кэш в памяти.
 */
export interface MenuCache {
  /** Готовое меню или null, если в кэше его нет. */
  read(restaurantId: string, includeUnavailable: boolean): Promise<MenuSection[] | null>;

  write(restaurantId: string, includeUnavailable: boolean, sections: MenuSection[]): Promise<void>;

  /** Сбрасывает оба варианта меню ресторана — и клиентский, и для менеджера. */
  invalidate(restaurantId: string): Promise<void>;
}

export const MENU_CACHE = Symbol("MenuCache");
