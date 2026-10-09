import { ExternalServiceError } from "@food-delivery/shared";

export type CircuitState = "closed" | "open" | "half-open";

/**
 * Вызов отклонён разомкнутой цепью, в сеть он не уходил.
 *
 * Отдельный класс нужен повтору: повторять такой вызов сразу бессмысленно —
 * цепь разомкнута на известное время. А вот оркестратор саги вправе
 * повторить шаг позже, поэтому ошибка остаётся повторяемой.
 */
export class CircuitOpenError extends ExternalServiceError {}

export interface CircuitBreakerOptions {
  /** Имя зависимости — попадает в текст ошибки, журнал и метрики. */
  name: string;
  /** Сколько отказов подряд размыкают цепь. */
  failureThreshold: number;
  /** Сколько цепь остаётся разомкнутой, прежде чем пропустить пробный вызов. */
  openDurationMs: number;
  /** Вызывается при каждой смене состояния — для журнала и метрик. */
  onStateChange?: (state: CircuitState, name: string) => void;
  /** Источник времени; подменяется в тестах. */
  now?: () => number;
}

/**
 * Размыкатель цепи (Circuit Breaker).
 *
 * Без него отказавший сосед продолжает получать запросы, каждый из которых
 * ждёт таймаута. Ожидающие запросы занимают соединения и память вызывающего,
 * и отказ одного сервиса перерастает в отказ цепочки — каскадный отказ.
 *
 * Состояния:
 *   closed    — вызовы идут как обычно, отказы подряд считаются;
 *   open      — после порога отказов вызовы отклоняются сразу, без сети:
 *               вызывающий получает ошибку за миллисекунды, а не за таймаут;
 *   half-open — по истечении паузы пропускается один пробный вызов:
 *               успех замыкает цепь, отказ размыкает её снова.
 *
 * Считаются только отказы зависимости (сеть, таймаут, ответ 5xx).
 * Ответ «не найдено» или «нарушено правило» — штатный ответ работающего
 * сервиса, и размыкать из-за него цепь было бы ошибкой.
 */
export class CircuitBreaker {
  private state: CircuitState = "closed";
  private consecutiveFailures = 0;
  private openedAt = 0;
  private probeInFlight = false;
  private readonly now: () => number;

  constructor(private readonly options: CircuitBreakerOptions) {
    if (options.failureThreshold < 1) {
      throw new Error("failureThreshold должен быть не меньше 1");
    }
    this.now = options.now ?? Date.now;
  }

  get currentState(): CircuitState {
    // Переход open → half-open происходит по времени, а не по событию:
    // состояние вычисляется при обращении.
    if (this.state === "open" && this.now() - this.openedAt >= this.options.openDurationMs) {
      return "half-open";
    }
    return this.state;
  }

  /**
   * Выполнить вызов через размыкатель.
   *
   * @param isFailure какие ошибки считать отказом зависимости. По умолчанию —
   *   все; клиенты уточняют, чтобы штатные ответы 4xx цепь не размыкали.
   */
  async execute<T>(call: () => Promise<T>, isFailure: (error: unknown) => boolean = () => true) {
    const state = this.currentState;

    if (state === "open" || (state === "half-open" && this.probeInFlight)) {
      throw new CircuitOpenError(`${this.options.name} временно недоступен`, {
        dependency: this.options.name,
        circuit: "open",
      });
    }

    if (state === "half-open") {
      this.probeInFlight = true;
      this.setState("half-open");
    }

    try {
      const result: T = await call();
      this.onSuccess();
      return result;
    } catch (error) {
      if (isFailure(error)) this.onFailure();
      else this.onSuccess();
      throw error;
    } finally {
      if (state === "half-open") this.probeInFlight = false;
    }
  }

  private onSuccess(): void {
    this.consecutiveFailures = 0;
    if (this.state !== "closed") this.setState("closed");
  }

  private onFailure(): void {
    this.consecutiveFailures += 1;
    // Отказ пробного вызова размыкает цепь сразу, не дожидаясь порога.
    if (this.state === "half-open" || this.consecutiveFailures >= this.options.failureThreshold) {
      this.openedAt = this.now();
      this.setState("open");
    }
  }

  private setState(next: CircuitState): void {
    if (this.state === next) return;
    this.state = next;
    this.options.onStateChange?.(next, this.options.name);
  }
}
