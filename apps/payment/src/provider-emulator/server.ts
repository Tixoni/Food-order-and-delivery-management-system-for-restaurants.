import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Logger } from "@food-delivery/shared";
import type { ProviderEmulator } from "./emulator";

/** Наибольший размер тела запроса: эмулятору достаточно килобайтов. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * HTTP-обёртка эмулятора — без фреймворка: эмулятор изображает внешнюю
 * систему, и тянуть в него каркас сервисов незачем.
 *
 * В журнал попадают только метод, путь и код ответа — ни тела запроса,
 * ни тела ответа (SEC-3).
 */
export function startEmulatorServer(
  emulator: ProviderEmulator,
  port: number,
  logger: Logger,
): Promise<Server> {
  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://emulator");
      let result;
      try {
        const body = await readJson(request);
        result = await emulator.handle({
          method: request.method ?? "GET",
          path: url.pathname,
          headers: request.headers as Record<string, string | undefined>,
          body,
        });
      } catch (error) {
        result = {
          status: 400,
          body: { type: "error", code: "invalid_request", description: String(error) },
        };
      }

      response.writeHead(result.status, { "content-type": "application/json" });
      response.end(JSON.stringify(result.body));
      logger.info("запрос к эмулятору", {
        method: request.method,
        path: url.pathname.replace(/[0-9a-f-]{36}/g, ":id"),
        status: result.status,
      });
    })();
  });

  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return undefined;
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
