import { promises as dns } from "node:dns";
import { isIP } from "node:net";
import Redis from "ioredis";

export interface ResilientRedisOptions {
  host: string;
  port: number;
  commandTimeoutMs: number;
  onError: (error: Error) => void;
}

/**
 * Не даёт фоновым подключениям Redis задерживать запросы к другим сервисам.
 *
 * Когда DNS-имя Redis исчезает, net.connect внутри ioredis использует
 * блокирующий пул getaddrinfo. Несколько его бесконечных переподключений
 * задерживают разрешение имён Catalog/Kafka. Здесь адрес сначала ищется через
 * асинхронный DNS (c-ares), а TCP-подключение выполняется уже по IP.
 */
export class ResilientRedisClient {
  private client: Redis | null = null;
  private readonly timer: NodeJS.Timeout;
  private connecting = false;
  private stopped = false;

  constructor(private readonly options: ResilientRedisOptions) {
    this.timer = setInterval(() => void this.ensureConnected(), 5000);
    this.timer.unref?.();
    void this.ensureConnected();
  }

  get readyClient(): Redis | null {
    return this.client?.status === "ready" ? this.client : null;
  }

  disconnect(): void {
    this.stopped = true;
    clearInterval(this.timer);
    this.client?.disconnect();
    this.client = null;
  }

  private async ensureConnected(): Promise<void> {
    if (this.stopped || this.connecting || this.readyClient) return;
    this.connecting = true;
    try {
      const address = isIP(this.options.host)
        ? this.options.host
        : (await dns.resolve4(this.options.host))[0];
      if (!address) throw new Error(`Redis DNS не вернул адрес: ${this.options.host}`);
      if (this.stopped) return;

      this.client?.disconnect();
      const client = new Redis({
        host: address,
        port: this.options.port,
        lazyConnect: true,
        connectTimeout: 1000,
        commandTimeout: this.options.commandTimeoutMs,
        maxRetriesPerRequest: 1,
        enableOfflineQueue: false,
        // Повтором управляет этот класс, а не бесконечный цикл ioredis.
        retryStrategy: () => null,
      });
      this.client = client;
      client.on("error", this.options.onError);
      try {
        await client.connect();
      } catch (error) {
        this.options.onError(error instanceof Error ? error : new Error(String(error)));
        client.disconnect();
        if (this.client === client) this.client = null;
      }
    } catch (error) {
      this.options.onError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      this.connecting = false;
    }
  }
}
