import { randomUUID } from "node:crypto";
import { Inject, Injectable } from "@nestjs/common";
import { ConflictError, NotFoundError, createEvent, getCorrelationId } from "@food-delivery/shared";
import { CATALOG_EVENT_TYPES } from "@food-delivery/contracts";
import type { DomainEvent } from "@food-delivery/shared";
import type { MenuItemRestoredPayload, MenuItemStoppedPayload } from "@food-delivery/contracts";
import type { MenuItem } from "../../domain/menu-item";
import { StopListEntry } from "../../domain/stop-list";
import { MENU_CACHE, type MenuCache } from "../ports/menu-cache";
import { MENU_REPOSITORY, type MenuRepository } from "../ports/menu.repository";
import { STOP_LIST_REPOSITORY, type StopListRepository } from "../ports/stop-list.repository";

/**
 * Стоп-лист — требование CAT-4.
 *
 * На кухне закончились ингредиенты: блюдо должно исчезнуть из выдачи
 * не позднее пяти секунд, иначе клиент закажет то, чего нет, и заказ
 * придётся отменять с возвратом денег.
 *
 * Пять секунд складываются из двух частей, и обе решаются здесь:
 *   1. собственный кэш каталога сбрасывается сразу после записи;
 *   2. событие уходит в брокер, и кэш шлюза сбрасывается по нему.
 *
 * Событие пишется в таблицу исходящих сообщений той же транзакцией,
 * что и сам признак доступности (REL-3): иначе сбой между фиксацией
 * транзакции и отправкой в брокер оставил бы кэш шлюза со старым меню.
 */

export interface SetAvailabilityInput {
  itemId: string;
  restaurantId: string;
  isAvailable: boolean;
  /** Причина со слов сотрудника — попадает в журнал и в событие. */
  reason?: string | null;
  /** Кто изменил. Заполняется вместе с ролями (шаг 1.4). */
  actorId?: string | null;
}

export interface SetAvailabilityResult {
  item: MenuItem;
  entry: StopListEntry;
  /** Ложь означает, что блюдо уже было в этом состоянии и ничего не менялось. */
  changed: boolean;
}

@Injectable()
export class SetMenuItemAvailabilityUseCase {
  constructor(
    @Inject(MENU_REPOSITORY) private readonly menu: MenuRepository,
    @Inject(STOP_LIST_REPOSITORY) private readonly stopList: StopListRepository,
    @Inject(MENU_CACHE) private readonly cache: MenuCache,
  ) {}

  async execute(input: SetAvailabilityInput): Promise<SetAvailabilityResult> {
    const item = await this.menu.findItemById(input.itemId);
    if (!item) {
      throw new NotFoundError("блюдо не найдено", { itemId: input.itemId });
    }
    if (item.restaurantId !== input.restaurantId) {
      throw new ConflictError("блюдо принадлежит другому ресторану", { itemId: input.itemId });
    }

    const active = await this.stopList.findActiveEntry(item.id);
    const now = new Date();

    // Повторное нажатие той же кнопки ничего не меняет и события
    // не порождает. Иначе кухня, дважды отметив «закончилось», разослала бы
    // потребителям два одинаковых сообщения и сбросила кэш дважды.
    if (item.isAvailable === input.isAvailable) {
      return {
        item,
        entry: active ?? StopListEntry.open({ id: randomUUID(), menuItemId: item.id, at: now }),
        changed: false,
      };
    }

    const change = input.isAvailable
      ? this.restore(item, active, now)
      : this.stop(item, input, now);

    await this.stopList.commit({ item: change.item, entry: change.entry, events: change.events });

    // Сброс собственного кэша — сразу после успешной записи, а не до неё:
    // упавшая транзакция не должна оставлять пустой кэш.
    await this.cache.invalidate(item.restaurantId);

    return { item: change.item, entry: change.entry, changed: true };
  }

  /** Блюдо убирается из продажи: открывается запись журнала. */
  private stop(
    item: MenuItem,
    input: SetAvailabilityInput,
    now: Date,
  ): { item: MenuItem; entry: StopListEntry; events: DomainEvent[] } {
    const entry = StopListEntry.open({
      id: randomUUID(),
      menuItemId: item.id,
      reason: input.reason ?? null,
      stoppedBy: input.actorId ?? null,
      at: now,
    });

    const payload: MenuItemStoppedPayload = {
      restaurantId: item.restaurantId,
      menuItemId: item.id,
      name: item.name,
      reason: entry.reason,
      stoppedAt: now.toISOString(),
    };

    return {
      item: item.withAvailability(false),
      entry,
      events: [this.event(CATALOG_EVENT_TYPES.menuItemStopped, item, payload)],
    };
  }

  /** Блюдо возвращается в продажу: действующая запись журнала закрывается. */
  private restore(
    item: MenuItem,
    active: StopListEntry | null,
    now: Date,
  ): { item: MenuItem; entry: StopListEntry; events: DomainEvent[] } {
    // Записи может не быть: блюдо могло стать недоступным до появления
    // журнала — например, при наполнении базы тестовыми данными. Заводим
    // запись нулевой длительности, чтобы возврат всё равно остался
    // в истории; врать о времени простоя нельзя.
    const opened =
      active ??
      StopListEntry.open({
        id: randomUUID(),
        menuItemId: item.id,
        reason: "запись о переводе в стоп-лист отсутствует",
        at: now,
      });

    const entry = opened.restore(now);

    const payload: MenuItemRestoredPayload = {
      restaurantId: item.restaurantId,
      menuItemId: item.id,
      name: item.name,
      restoredAt: now.toISOString(),
      outageMinutes: entry.outageMinutes(now),
    };

    return {
      item: item.withAvailability(true),
      entry,
      events: [this.event(CATALOG_EVENT_TYPES.menuItemRestored, item, payload)],
    };
  }

  /**
   * Конверт события. correlationId берётся из контекста запроса, поэтому
   * запись журнала кухни, событие в брокере и сброс кэша на шлюзе
   * находятся одним запросом (OBS-1).
   */
  private event(eventType: string, item: MenuItem, payload: object): DomainEvent {
    return createEvent({
      eventType,
      aggregateType: "MenuItem",
      aggregateId: item.id,
      correlationId: getCorrelationId(),
      payload,
    });
  }
}
