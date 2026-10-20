import { getCorrelationId } from "@food-delivery/shared";
import { CORRELATION_HEADER, CorrelationMiddleware } from "./correlation.middleware";

/** Какой идентификатор получит обработка запроса с этим заголовком. */
function correlationOf(incoming: string | undefined): string {
  let seen = "";
  new CorrelationMiddleware().use(
    { headers: { [CORRELATION_HEADER]: incoming } },
    { setHeader: () => undefined },
    () => (seen = getCorrelationId()),
  );
  return seen;
}

describe("сквозной идентификатор от вызывающего", () => {
  it("принимается, если похож на идентификатор: им связывают журналы действия (OBS-1)", () => {
    expect(correlationOf("obs1-6f1c2a9e-0b7d-4c55-9a1e-3d2f8b7c6a10")).toBe(
      "obs1-6f1c2a9e-0b7d-4c55-9a1e-3d2f8b7c6a10",
    );
  });

  it("длинный или произвольный — заменяется новым: иначе сорвал бы запись в базах", () => {
    for (const incoming of ["x".repeat(101), "a b", "<script>", ""]) {
      expect(correlationOf(incoming)).toMatch(/^[0-9a-f-]{36}$/);
    }
  });
});
