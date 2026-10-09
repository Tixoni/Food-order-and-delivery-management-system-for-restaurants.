import type { Kopecks } from "./money";

/**
 * Состояние саги оформления заказа.
 *
 * Сага живёт дольше одной команды: от оформления до вручения проходят
 * десятки минут, и всё это время нужно помнить, что уже сделано у участников.
 * Именно по этим фактам выбираются компенсации: снимать ли холд, возвращать ли
 * списанное, освобождать ли курьера. Компенсация — не откат, а новое действие:
 * списанные деньги не «откатываются», а возвращаются отдельной операцией.
 */

/** Вызовы участников, которые выполняет фоновый исполнитель саги. */
export const SAGA_STEPS = {
  authorizePayment: "AUTHORIZE_PAYMENT",
  capturePayment: "CAPTURE_PAYMENT",
  requestCourier: "REQUEST_COURIER",
  voidPayment: "VOID_PAYMENT",
  refundPayment: "REFUND_PAYMENT",
  releaseCourier: "RELEASE_COURIER",
} as const;

export type SagaStep = (typeof SAGA_STEPS)[keyof typeof SAGA_STEPS];

export const COMPENSATIONS: ReadonlySet<string> = new Set([
  SAGA_STEPS.voidPayment,
  SAGA_STEPS.refundPayment,
  SAGA_STEPS.releaseCourier,
]);

/** Прямые шаги: при отмене заказа их выполнение теряет смысл. */
export const FORWARD_STEPS: readonly SagaStep[] = [
  SAGA_STEPS.authorizePayment,
  SAGA_STEPS.capturePayment,
  SAGA_STEPS.requestCourier,
];

export type SagaStatus = "RUNNING" | "COMPENSATING" | "COMPLETED" | "FAILED";

/** Что известно о действиях участников. */
export interface SagaFacts {
  paymentId: string | null;
  paymentAuthorized: boolean;
  paymentCaptured: boolean;
  capturedAmount: Kopecks;
  paymentVoided: boolean;
  refundedAmount: Kopecks;
  /** Сколько вернуть при отмене оператором; по умолчанию — всё списанное. */
  refundTarget: Kopecks | null;
  /**
   * Снятие холда «на всякий случай»: вызов холдирования закончился ничем
   * (таймаут, сервис недоступен), и неизвестно, держит ли банк деньги.
   * Снятие безопасно и без холда, а без него деньги могли бы зависнуть.
   */
  defensiveVoidPending: boolean;
  courierRequested: boolean;
  courierReleased: boolean;
  deliveryId: string | null;
  courierId: string | null;
  /**
   * Порядковые номера компенсаций. Входят в ключ идемпотентности:
   * повтор одной и той же компенсации получает тот же ключ, а новая
   * компенсация — новый. Иначе снятие холда, выполненное до того, как холд
   * появился, «заняло» бы ключ, и настоящее снятие получило бы старый ответ.
   */
  voidSeq: number;
  refundSeq: number;
  courierSeq: number;
}

export const INITIAL_FACTS: SagaFacts = {
  paymentId: null,
  paymentAuthorized: false,
  paymentCaptured: false,
  capturedAmount: 0,
  paymentVoided: false,
  refundedAmount: 0,
  refundTarget: null,
  defensiveVoidPending: false,
  courierRequested: false,
  courierReleased: false,
  deliveryId: null,
  courierId: null,
  voidSeq: 0,
  refundSeq: 0,
  courierSeq: 0,
};

export interface SagaState {
  id: string;
  orderId: string;
  /**
   * Сквозной идентификатор действия, начавшего сагу. Шаги выполняются
   * фоновым процессом, а не в запросе пользователя, — без сохранённого
   * идентификатора трасса оформления рвалась бы на первом же шаге (OBS-2).
   */
  correlationId: string;
  status: SagaStatus;
  currentStep: string;
  facts: SagaFacts;
  version: number;
}

/** Какие компенсации ещё нужны, чтобы деньги и курьер вернулись в исходное состояние. */
export interface PendingCompensations {
  void: boolean;
  refund: Kopecks;
  releaseCourier: boolean;
}

export class CheckoutSaga {
  private constructor(private readonly state: SagaState) {}

  static start(id: string, orderId: string, correlationId: string): CheckoutSaga {
    return new CheckoutSaga({
      id,
      orderId,
      correlationId,
      status: "RUNNING",
      currentStep: SAGA_STEPS.authorizePayment,
      facts: { ...INITIAL_FACTS },
      version: 0,
    });
  }

  static restore(state: SagaState): CheckoutSaga {
    return new CheckoutSaga({ ...state, facts: { ...INITIAL_FACTS, ...state.facts } });
  }

  get id() {
    return this.state.id;
  }
  get orderId() {
    return this.state.orderId;
  }
  get correlationId() {
    return this.state.correlationId;
  }
  get status() {
    return this.state.status;
  }
  get version() {
    return this.state.version;
  }
  get facts(): Readonly<SagaFacts> {
    return this.state.facts;
  }

  snapshot(): Readonly<SagaState> {
    return { ...this.state, facts: { ...this.state.facts } };
  }

  markPersisted(version: number): void {
    this.state.version = version;
  }

  at(step: string): void {
    this.state.currentStep = step;
  }

  record(patch: Partial<SagaFacts>): void {
    Object.assign(this.state.facts, patch);
  }

  /**
   * Что осталось компенсировать, исходя из фактов. Правило денег:
   * после холда любой исход, кроме вручения, обязан вернуть средства.
   */
  pendingCompensations(): PendingCompensations {
    const f = this.state.facts;
    const refundGoal = Math.min(f.refundTarget ?? f.capturedAmount, f.capturedAmount);
    return {
      void:
        (f.paymentAuthorized && !f.paymentCaptured && !f.paymentVoided) || f.defensiveVoidPending,
      refund: f.paymentCaptured ? Math.max(0, refundGoal - f.refundedAmount) : 0,
      releaseCourier: f.courierRequested && !f.courierReleased,
    };
  }

  compensate(): void {
    if (this.state.status === "RUNNING") this.state.status = "COMPENSATING";
  }

  /** Всё возвращено: холда нет, списанное возвращено, курьер свободен. */
  get fullyCompensated(): boolean {
    const pending = this.pendingCompensations();
    return !pending.void && pending.refund === 0 && !pending.releaseCourier;
  }

  complete(): void {
    this.state.status = "COMPLETED";
    this.state.currentStep = "DONE";
  }

  /** Отмена доведена до конца: компенсации выполнены. */
  finishCompensation(): void {
    this.state.status = "FAILED";
    this.state.currentStep = "DONE";
  }

  /** Новая компенсация — новый порядковый номер для ключа идемпотентности. */
  nextSeq(kind: "voidSeq" | "refundSeq" | "courierSeq"): number {
    this.state.facts[kind] += 1;
    return this.state.facts[kind];
  }
}
