import { assertAmount, type Kopecks } from "./money";
import { PaymentRuleError } from "./payment-errors";

/**
 * Платёж по заказу и его маленький автомат статусов.
 *
 *   PENDING ──authorize──▶ AUTHORIZED ──capture──▶ CAPTURED ──refund──▶ PARTIALLY_REFUNDED / REFUNDED
 *      │                      │
 *      └──decline──▶ DECLINED └──void──▶ VOIDED
 *
 * Снятие холда (VOIDED) и возврат (REFUNDED) — разные операции с разными
 * последствиями: первое отпускает ещё не списанные деньги, второе
 * возвращает списанные. Поэтому и статусы разные.
 *
 * Каждая операция проходит два шага: «можно ли начать» — до обращения
 * к провайдеру, и «что изменилось» — по его ответу. Между ними идёт
 * сетевой вызов, и держать платёж заблокированным на это время нельзя.
 */

export type PaymentStatus =
  "PENDING" | "AUTHORIZED" | "CAPTURED" | "PARTIALLY_REFUNDED" | "REFUNDED" | "DECLINED" | "VOIDED";

export type OperationType = "AUTHORIZE" | "CAPTURE" | "VOID" | "REFUND";

export interface PaymentState {
  id: string;
  orderId: string;
  customerId: string;
  /** Сумма холда; списывается целиком. */
  amount: Kopecks;
  refundedAmount: Kopecks;
  status: PaymentStatus;
  providerPaymentId: string | null;
  authorizedAt: Date | null;
  capturedAt: Date | null;
  version: number;
}

/** Что отправить провайдеру, если операцию можно начать. */
export interface OperationPlan {
  type: OperationType;
  amount: Kopecks;
}

const CAPTURED_STATES: PaymentStatus[] = ["CAPTURED", "PARTIALLY_REFUNDED", "REFUNDED"];

const STATUS_TEXT: Record<PaymentStatus, string> = {
  PENDING: "ожидает холда",
  AUTHORIZED: "захолдирован",
  CAPTURED: "списан",
  PARTIALLY_REFUNDED: "частично возвращён",
  REFUNDED: "возвращён",
  DECLINED: "отклонён",
  VOIDED: "холд снят",
};

export class Payment {
  private constructor(private state: PaymentState) {}

  static restore(state: PaymentState): Payment {
    return new Payment({ ...state });
  }

  /** Новый платёж до обращения к провайдеру. */
  static open(input: {
    id: string;
    orderId: string;
    customerId: string;
    amount: Kopecks;
  }): Payment {
    assertAmount(input.amount);
    return new Payment({
      ...input,
      refundedAmount: 0,
      status: "PENDING",
      providerPaymentId: null,
      authorizedAt: null,
      capturedAt: null,
      version: 1,
    });
  }

  get snapshot(): Readonly<PaymentState> {
    return this.state;
  }

  get id() {
    return this.state.id;
  }

  get status() {
    return this.state.status;
  }

  /** Сколько ещё можно вернуть. */
  get refundable(): Kopecks {
    return CAPTURED_STATES.includes(this.state.status)
      ? this.state.amount - this.state.refundedAmount
      : 0;
  }

  /* ─────────── Можно ли начать операцию ─────────── */

  planCapture(): OperationPlan {
    this.require(["AUTHORIZED"], "списать можно только захолдированный платёж");
    return { type: "CAPTURE", amount: this.state.amount };
  }

  /**
   * Снятие холда. Это компенсация, и вызывают её «на всякий случай» —
   * например, когда неизвестно, прошёл ли холд. Поэтому без холда она
   * не ошибка, а пустая операция (`null`). Ошибка — только попытка
   * снять холд со списанного платежа: там нужен возврат.
   */
  planVoid(): OperationPlan | null {
    if (CAPTURED_STATES.includes(this.state.status)) {
      throw new PaymentRuleError("нельзя снять холд со списанного платежа — нужен возврат", {
        status: this.state.status,
      });
    }
    if (this.state.status !== "AUTHORIZED") return null;
    return { type: "VOID", amount: this.state.amount };
  }

  planRefund(amount: Kopecks): OperationPlan {
    assertAmount(amount);
    this.require(["CAPTURED", "PARTIALLY_REFUNDED"], "вернуть можно только списанные средства");
    if (amount > this.refundable) {
      throw new PaymentRuleError("сумма возврата больше, чем осталось вернуть", {
        requested: amount,
        refundable: this.refundable,
      });
    }
    return { type: "REFUND", amount };
  }

  /* ─────────── Что изменилось по ответу провайдера ─────────── */

  authorized(providerPaymentId: string, at: Date): void {
    this.require(["PENDING"], "холд уже обработан");
    this.state.status = "AUTHORIZED";
    this.state.providerPaymentId = providerPaymentId;
    this.state.authorizedAt = at;
  }

  declined(providerPaymentId: string | null): void {
    this.require(["PENDING"], "холд уже обработан");
    this.state.status = "DECLINED";
    this.state.providerPaymentId = providerPaymentId;
  }

  captured(at: Date): void {
    this.require(["AUTHORIZED"], "списать можно только захолдированный платёж");
    this.state.status = "CAPTURED";
    this.state.capturedAt = at;
  }

  voided(): void {
    this.require(["AUTHORIZED"], "снять можно только действующий холд");
    this.state.status = "VOIDED";
  }

  refunded(amount: Kopecks): void {
    this.planRefund(amount);
    this.state.refundedAmount += amount;
    this.state.status =
      this.state.refundedAmount === this.state.amount ? "REFUNDED" : "PARTIALLY_REFUNDED";
  }

  private require(allowed: PaymentStatus[], message: string): void {
    if (!allowed.includes(this.state.status)) {
      throw new PaymentRuleError(`${message}: платёж ${STATUS_TEXT[this.state.status]}`, {
        status: this.state.status,
      });
    }
  }
}
