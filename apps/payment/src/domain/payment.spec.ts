import { fromProviderValue, toProviderValue } from "./money";
import { Payment } from "./payment";
import { PaymentRuleError } from "./payment-errors";

const at = new Date("2026-10-10T12:00:00Z");

function opened(amount = 150_000) {
  return Payment.open({ id: "p-1", orderId: "o-1", customerId: "c-1", amount });
}

function captured(amount = 150_000) {
  const payment = opened(amount);
  payment.authorized("prov-1", at);
  payment.captured(at);
  return payment;
}

describe("Payment", () => {
  it("проходит путь холд → списание → частичный и полный возврат", () => {
    const payment = opened();
    payment.authorized("prov-1", at);
    expect(payment.planCapture()).toEqual({ type: "CAPTURE", amount: 150_000 });

    payment.captured(at);
    payment.refunded(50_000);
    expect(payment.status).toBe("PARTIALLY_REFUNDED");
    expect(payment.refundable).toBe(100_000);

    payment.refunded(100_000);
    expect(payment.status).toBe("REFUNDED");
    expect(payment.refundable).toBe(0);
  });

  it("не списывает неавторизованный платёж", () => {
    expect(() => opened().planCapture()).toThrow(PaymentRuleError);

    const declined = opened();
    declined.declined(null);
    expect(() => declined.planCapture()).toThrow("платёж отклонён");
  });

  it("не возвращает несписанные средства", () => {
    const payment = opened();
    payment.authorized("prov-1", at);
    expect(() => payment.planRefund(100)).toThrow("вернуть можно только списанные средства");
  });

  it("не возвращает больше, чем осталось вернуть", () => {
    const payment = captured(10_000);
    payment.refunded(7_000);
    expect(() => payment.planRefund(3_001)).toThrow("больше, чем осталось вернуть");
    expect(() => payment.refunded(3_001)).toThrow(PaymentRuleError);
    expect(payment.snapshot.refundedAmount).toBe(7_000);
  });

  it("снятие холда без холда — пустая операция, а не ошибка", () => {
    expect(opened().planVoid()).toBeNull();

    const voided = opened();
    voided.authorized("prov-1", at);
    expect(voided.planVoid()).toEqual({ type: "VOID", amount: 150_000 });
    voided.voided();
    expect(voided.planVoid()).toBeNull();
  });

  it("со списанного платежа холд не снимается — нужен возврат", () => {
    expect(() => captured().planVoid()).toThrow("нужен возврат");
  });

  it("повторный ответ провайдера на холд не меняет обработанный платёж", () => {
    const payment = opened();
    payment.authorized("prov-1", at);
    expect(() => payment.authorized("prov-2", at)).toThrow("холд уже обработан");
    expect(payment.snapshot.providerPaymentId).toBe("prov-1");
  });

  it.each([0, -100, 10.5, Number.NaN])("не принимает сумму %p", (amount) => {
    expect(() => opened(amount)).toThrow(PaymentRuleError);
    expect(() => captured().planRefund(amount)).toThrow(PaymentRuleError);
  });
});

describe("суммы провайдера", () => {
  it.each([
    [1, "0.01"],
    [10, "0.10"],
    [39_050, "390.50"],
    [100_000_00, "100000.00"],
  ])("%p копеек ↔ %p", (kopecks, value) => {
    expect(toProviderValue(kopecks)).toBe(value);
    expect(fromProviderValue(value)).toBe(kopecks);
  });

  it("понимает сокращённую запись без потери копеек", () => {
    expect(fromProviderValue("390.5")).toBe(39_050);
    expect(fromProviderValue("390")).toBe(39_000);
    // Число с плавающей точкой здесь дало бы 1004.9999…
    expect(fromProviderValue("10.05")).toBe(1_005);
  });

  it.each(["", "abc", "1,50", "-5.00", "1.234"])("отклоняет %p", (value) => {
    expect(() => fromProviderValue(value)).toThrow(PaymentRuleError);
  });
});
