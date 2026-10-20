/**
 * Журнал стоп-листа.
 *
 * Текущее состояние блюда лежит в самом блюде (`MenuItem.isAvailable`) —
 * так выдача меню не требует соединения таблиц. Здесь копится история:
 * когда блюдо убрали, по какой причине, кто убрал и когда вернули.
 *
 * Зачем нужна история, если есть текущее состояние: «сколько часов в неделю
 * не продавалась пицца „Маргарита“» по одному признаку доступности
 * не восстановить. Это материал для показателей ресторана (ADM-4)
 * и для разбора спорных ситуаций с заказами.
 */

export class StopListError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StopListError";
  }
}

const MAX_REASON = 500;

export interface StopListEntryProps {
  id: string;
  menuItemId: string;
  /** Причина со слов сотрудника: «закончились ингредиенты». Необязательна. */
  reason: string | null;
  /** Кто перевёл в стоп-лист: идентификатор пользователя из токена. */
  stoppedBy: string | null;
  stoppedAt: Date;
  /** Пока null — блюдо в стоп-листе. */
  restoredAt: Date | null;
}

export class StopListEntry {
  private constructor(
    readonly id: string,
    readonly menuItemId: string,
    readonly reason: string | null,
    readonly stoppedBy: string | null,
    readonly stoppedAt: Date,
    readonly restoredAt: Date | null,
  ) {}

  static create(props: StopListEntryProps): StopListEntry {
    if (props.id.trim().length === 0) {
      throw new StopListError("идентификатор записи стоп-листа не может быть пустым");
    }
    if (props.menuItemId.trim().length === 0) {
      throw new StopListError("запись стоп-листа должна ссылаться на блюдо");
    }

    const reason = props.reason?.trim() || null;
    if (reason && reason.length > MAX_REASON) {
      throw new StopListError(`причина длиннее ${MAX_REASON} символов`);
    }

    // Запись, закрытая раньше, чем открыта, означает ошибку в часах
    // или в порядке действий. Такую историю нельзя показывать
    // в показателях: она даст отрицательное время простоя.
    if (props.restoredAt && props.restoredAt.getTime() < props.stoppedAt.getTime()) {
      throw new StopListError("блюдо не может быть возвращено раньше, чем убрано");
    }

    return new StopListEntry(
      props.id,
      props.menuItemId,
      reason,
      props.stoppedBy?.trim() || null,
      props.stoppedAt,
      props.restoredAt,
    );
  }

  /** Открыть запись: блюдо убирается в стоп-лист. */
  static open(input: {
    id: string;
    menuItemId: string;
    reason?: string | null;
    stoppedBy?: string | null;
    at?: Date;
  }): StopListEntry {
    return StopListEntry.create({
      id: input.id,
      menuItemId: input.menuItemId,
      reason: input.reason ?? null,
      stoppedBy: input.stoppedBy ?? null,
      stoppedAt: input.at ?? new Date(),
      restoredAt: null,
    });
  }

  /** Блюдо всё ещё в стоп-листе по этой записи. */
  get isActive(): boolean {
    return this.restoredAt === null;
  }

  /** Сколько блюдо отсутствовало в продаже. Для незакрытой записи — по текущий момент. */
  outageMinutes(now: Date = new Date()): number {
    const end = this.restoredAt ?? now;
    return Math.max(0, Math.round((end.getTime() - this.stoppedAt.getTime()) / 60_000));
  }

  /**
   * Закрыть запись: блюдо возвращается в продажу.
   *
   * Возвращается новое состояние, а не изменяется текущее, — как и везде
   * в домене. Повторное закрытие запрещено: иначе время простоя
   * перезапишется и показатели окажутся неверными.
   */
  restore(at: Date = new Date()): StopListEntry {
    if (!this.isActive) {
      throw new StopListError("запись стоп-листа уже закрыта");
    }

    return StopListEntry.create({ ...this.toProps(), restoredAt: at });
  }

  toProps(): StopListEntryProps {
    return {
      id: this.id,
      menuItemId: this.menuItemId,
      reason: this.reason,
      stoppedBy: this.stoppedBy,
      stoppedAt: this.stoppedAt,
      restoredAt: this.restoredAt,
    };
  }
}
