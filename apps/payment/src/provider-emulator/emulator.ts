import { randomUUID } from "node:crypto";

/**
 * Эмулятор платёжного провайдера с подмножеством контракта ЮKassa (API v3).
 *
 * Боевой эквайринг недоступен без юридического лица, поэтому система
 * работает с эмулятором — но эмулятор обязан вести себя как провайдер,
 * а не как «всегда успех»:
 *   — суммы строкой в рублях (`"390.00"`), статусы и ошибки провайдера;
 *   — заголовок `Idempotence-Key`: повтор с тем же ключом получает
 *     сохранённый ответ, деньги второй раз не двигаются;
 *   — свой автомат платежа: списать отменённый или вернуть больше
 *     списанного нельзя;
 *   — управляемые отказы и задержки — без них не проверить компенсации
 *     саги (REL-5) и размыкатель цепи. Режимы меняются на лету через
 *     служебный адрес `/_emulator/settings`, без перезапуска.
 *
 * Данных карт эмулятор не принимает и не хранит (SEC-3).
 */

export type EmulatorOperation = "create" | "capture" | "cancel" | "refund";

export interface EmulatorSettings {
  /** Операция, на которой провайдер «падает» (500) до выполнения. */
  failOperation: EmulatorOperation | null;
  /** Операция, которая выполняется, но ответ «теряется» (500 после выполнения). */
  loseResponseOperation: EmulatorOperation | null;
  /** Доля случайных отказов 500, от 0 до 1. */
  failureRate: number;
  /** Задержка каждого ответа. */
  delayMs: number;
  /** Холд дороже этой суммы (в копейках) банк отклоняет. */
  declineAbove: number | null;
}

export const DEFAULT_SETTINGS: EmulatorSettings = {
  failOperation: null,
  loseResponseOperation: null,
  failureRate: 0,
  delayMs: 0,
  declineAbove: null,
};

export interface EmulatorRequest {
  method: string;
  path: string;
  headers: Record<string, string | undefined>;
  body: unknown;
}

export interface EmulatorResponse {
  status: number;
  body: unknown;
}

interface Amount {
  value: string;
  currency: string;
}

interface ProviderPayment {
  id: string;
  status: "waiting_for_capture" | "succeeded" | "canceled";
  paid: boolean;
  amount: Amount;
  refunded_amount: Amount;
  created_at: string;
  metadata: Record<string, string>;
  cancellation_details?: { party: string; reason: string };
}

const OPERATIONS: EmulatorOperation[] = ["create", "capture", "cancel", "refund"];

export class ProviderEmulator {
  settings: EmulatorSettings;
  private readonly payments = new Map<string, ProviderPayment>();
  private readonly responses = new Map<string, EmulatorResponse>();
  /** Сколько раз операция действительно выполнилась — для проверок PAY-4. */
  private readonly performed: Record<EmulatorOperation, number> = {
    create: 0,
    capture: 0,
    cancel: 0,
    refund: 0,
  };

  constructor(
    private readonly credentials: { shopId: string; secretKey: string },
    settings: Partial<EmulatorSettings> = {},
    private readonly random: () => number = Math.random,
    private readonly sleep: (ms: number) => Promise<void> = (ms) =>
      new Promise((resolve) => setTimeout(resolve, ms)),
  ) {
    this.settings = { ...DEFAULT_SETTINGS, ...settings };
  }

  async handle(request: EmulatorRequest): Promise<EmulatorResponse> {
    if (request.path === "/health") return { status: 200, body: { status: "ok" } };
    if (request.path.startsWith("/_emulator/")) return this.control(request);

    if (!this.authorized(request.headers.authorization)) {
      return error(401, "invalid_credentials", "Authentication by given credentials failed");
    }

    const route = this.route(request);
    if (!route) return error(404, "not_found", "Unknown endpoint");
    if (route.operation === "get") return this.get(route.paymentId!);

    const key = request.headers["idempotence-key"];
    if (!key) return error(400, "invalid_request", "Idempotence-Key header is required");

    if (this.settings.delayMs > 0) await this.sleep(this.settings.delayMs);

    // Отказ «до выполнения»: операция не выполнена, ответ не сохраняется.
    if (
      this.settings.failOperation === route.operation ||
      this.random() < this.settings.failureRate
    ) {
      return error(500, "internal_server_error", "Emulated provider failure");
    }

    // Повтор с тем же ключом — прежний ответ, деньги не двигаются.
    const stored = this.responses.get(key);
    const response = stored ?? this.perform(route.operation, route.paymentId, request.body);
    if (!stored && response.status < 500) this.responses.set(key, response);

    // Отказ «после выполнения»: деньги сдвинулись, а ответ до клиента не дошёл.
    if (this.settings.loseResponseOperation === route.operation) {
      return error(500, "internal_server_error", "Emulated lost response");
    }
    return response;
  }

  private perform(
    operation: EmulatorOperation,
    paymentId: string | undefined,
    body: unknown,
  ): EmulatorResponse {
    switch (operation) {
      case "create":
        return this.create(body);
      case "capture":
        return this.capture(paymentId!);
      case "cancel":
        return this.cancel(paymentId!);
      case "refund":
        return this.refund(body);
    }
  }

  private create(body: unknown): EmulatorResponse {
    const input = (body ?? {}) as {
      amount?: Amount;
      capture?: boolean;
      metadata?: Record<string, string>;
    };
    const kopecks = parseAmount(input.amount);
    if (kopecks === null) return error(400, "invalid_request", "amount is invalid");
    if (input.capture !== false) {
      return error(400, "invalid_request", "only two-stage payments (capture=false) are emulated");
    }

    const declined = this.settings.declineAbove !== null && kopecks > this.settings.declineAbove;
    const payment: ProviderPayment = {
      id: randomUUID(),
      status: declined ? "canceled" : "waiting_for_capture",
      paid: !declined,
      amount: input.amount!,
      refunded_amount: { value: "0.00", currency: input.amount!.currency },
      created_at: new Date().toISOString(),
      metadata: input.metadata ?? {},
      ...(declined
        ? { cancellation_details: { party: "payment_network", reason: "insufficient_funds" } }
        : {}),
    };
    this.payments.set(payment.id, payment);
    this.performed.create += 1;
    return { status: 200, body: payment };
  }

  private capture(paymentId: string): EmulatorResponse {
    const payment = this.payments.get(paymentId);
    if (!payment) return error(404, "not_found", "Payment not found");
    if (payment.status !== "waiting_for_capture") {
      return error(400, "invalid_request", `Payment is ${payment.status}, capture is impossible`);
    }
    payment.status = "succeeded";
    this.performed.capture += 1;
    return { status: 200, body: payment };
  }

  private cancel(paymentId: string): EmulatorResponse {
    const payment = this.payments.get(paymentId);
    if (!payment) return error(404, "not_found", "Payment not found");
    if (payment.status !== "waiting_for_capture") {
      return error(400, "invalid_request", `Payment is ${payment.status}, cancel is impossible`);
    }
    payment.status = "canceled";
    payment.paid = false;
    payment.cancellation_details = { party: "merchant", reason: "canceled_by_merchant" };
    this.performed.cancel += 1;
    return { status: 200, body: payment };
  }

  private refund(body: unknown): EmulatorResponse {
    const input = (body ?? {}) as { payment_id?: string; amount?: Amount };
    const payment = input.payment_id ? this.payments.get(input.payment_id) : undefined;
    if (!payment) return error(404, "not_found", "Payment not found");
    if (payment.status !== "succeeded") {
      return error(400, "invalid_request", `Payment is ${payment.status}, refund is impossible`);
    }
    const kopecks = parseAmount(input.amount);
    const refunded = parseAmount(payment.refunded_amount)!;
    const total = parseAmount(payment.amount)!;
    if (kopecks === null) return error(400, "invalid_request", "amount is invalid");
    if (refunded + kopecks > total) {
      return error(400, "invalid_request", "Refund amount exceeds the payment amount");
    }
    payment.refunded_amount = {
      value: formatAmount(refunded + kopecks),
      currency: payment.amount.currency,
    };
    this.performed.refund += 1;
    return {
      status: 200,
      body: {
        id: randomUUID(),
        payment_id: payment.id,
        status: "succeeded",
        amount: input.amount,
        created_at: new Date().toISOString(),
      },
    };
  }

  private get(paymentId: string): EmulatorResponse {
    const payment = this.payments.get(paymentId);
    return payment ? { status: 200, body: payment } : error(404, "not_found", "Payment not found");
  }

  /** Служебный адрес: режимы отказов, статистика, поиск платежей заказа. */
  private control(request: EmulatorRequest): EmulatorResponse {
    if (request.path === "/_emulator/settings") {
      if (request.method === "POST") {
        const patch = (request.body ?? {}) as Partial<EmulatorSettings>;
        const invalid = validateSettings(patch);
        if (invalid) return error(400, "invalid_request", invalid);
        this.settings = { ...this.settings, ...patch };
      }
      return { status: 200, body: this.settings };
    }
    if (request.path === "/_emulator/stats") {
      return {
        status: 200,
        body: { performed: this.performed, payments: this.payments.size },
      };
    }
    const byOrder = /^\/_emulator\/orders\/([^/]+)\/payments$/.exec(request.path);
    if (byOrder) {
      const payments = [...this.payments.values()].filter(
        (payment) => payment.metadata.orderId === byOrder[1],
      );
      return { status: 200, body: { items: payments } };
    }
    return error(404, "not_found", "Unknown control endpoint");
  }

  private route(request: EmulatorRequest) {
    const { method, path } = request;
    if (method === "POST" && path === "/v3/payments") return { operation: "create" as const };
    if (method === "POST" && path === "/v3/refunds") return { operation: "refund" as const };
    const match = /^\/v3\/payments\/([^/]+)(?:\/(capture|cancel))?$/.exec(path);
    if (!match) return null;
    const [, paymentId, action] = match;
    if (method === "GET" && !action) return { operation: "get" as const, paymentId };
    if (method === "POST" && action) return { operation: action as EmulatorOperation, paymentId };
    return null;
  }

  private authorized(header: string | undefined): boolean {
    const expected = Buffer.from(
      `${this.credentials.shopId}:${this.credentials.secretKey}`,
    ).toString("base64");
    return header === `Basic ${expected}`;
  }
}

function error(status: number, code: string, description: string): EmulatorResponse {
  return { status, body: { type: "error", id: randomUUID(), code, description } };
}

function parseAmount(amount: Amount | undefined): number | null {
  if (!amount || amount.currency !== "RUB" || typeof amount.value !== "string") return null;
  const match = /^(\d{1,12})\.(\d{2})$/.exec(amount.value);
  if (!match) return null;
  const kopecks = Number(match[1]) * 100 + Number(match[2]);
  return kopecks > 0 ? kopecks : null;
}

function formatAmount(kopecks: number): string {
  return `${Math.floor(kopecks / 100)}.${(kopecks % 100).toString().padStart(2, "0")}`;
}

function validateSettings(patch: Partial<EmulatorSettings>): string | null {
  for (const field of ["failOperation", "loseResponseOperation"] as const) {
    const value = patch[field];
    if (value !== undefined && value !== null && !OPERATIONS.includes(value)) {
      return `${field}: одно из ${OPERATIONS.join(", ")} или null`;
    }
  }
  if (patch.failureRate !== undefined && !(patch.failureRate >= 0 && patch.failureRate <= 1)) {
    return "failureRate: число от 0 до 1";
  }
  if (patch.delayMs !== undefined && !(Number.isInteger(patch.delayMs) && patch.delayMs >= 0)) {
    return "delayMs: целое неотрицательное число";
  }
  if (
    patch.declineAbove !== undefined &&
    patch.declineAbove !== null &&
    !(Number.isInteger(patch.declineAbove) && patch.declineAbove > 0)
  ) {
    return "declineAbove: копейки или null";
  }
  return null;
}
