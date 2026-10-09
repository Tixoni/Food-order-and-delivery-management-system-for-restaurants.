import { promises as dns } from "node:dns";
import Redis from "ioredis";
import { ResilientRedisClient } from "./resilient-redis.client";

jest.mock("node:dns", () => ({ promises: { resolve4: jest.fn() } }));
jest.mock("ioredis", () => jest.fn());

describe("ResilientRedisClient", () => {
  const resolve4 = dns.resolve4 as jest.Mock;
  const redisConstructor = Redis as unknown as jest.Mock;
  let instances: Array<{
    status: string;
    connect: jest.Mock;
    disconnect: jest.Mock;
    on: jest.Mock;
  }>;

  beforeEach(() => {
    jest.useFakeTimers();
    instances = [];
    resolve4.mockReset();
    redisConstructor.mockReset().mockImplementation(() => {
      const instance = {
        status: "wait",
        connect: jest.fn(async function (this: { status: string }) {
          this.status = "ready";
        }),
        disconnect: jest.fn(function (this: { status: string }) {
          this.status = "end";
        }),
        on: jest.fn(),
      };
      instances.push(instance);
      return instance;
    });
  });

  afterEach(() => jest.useRealTimers());

  it("keeps DNS failure outside the Redis connector and retries without blocking startup", async () => {
    resolve4.mockRejectedValueOnce(new Error("redis DNS unavailable"));
    resolve4.mockResolvedValueOnce(["172.21.0.6"]);
    const onError = jest.fn();
    const redis = new ResilientRedisClient({
      host: "redis",
      port: 6379,
      commandTimeoutMs: 200,
      onError,
    });
    await jest.advanceTimersByTimeAsync(0);

    expect(redis.readyClient).toBeNull();
    expect(redisConstructor).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: "redis DNS unavailable" }),
    );

    await jest.advanceTimersByTimeAsync(5000);
    expect(redis.readyClient).toBe(instances[0]);
    expect(redisConstructor).toHaveBeenCalledWith(
      expect.objectContaining({ host: "172.21.0.6", retryStrategy: expect.any(Function) }),
    );
    expect(instances[0].connect).toHaveBeenCalledTimes(1);
    redis.disconnect();
  });

  it("stops reconnecting after shutdown", async () => {
    resolve4.mockResolvedValue(["172.21.0.6"]);
    const redis = new ResilientRedisClient({
      host: "redis",
      port: 6379,
      commandTimeoutMs: 200,
      onError: jest.fn(),
    });
    await jest.advanceTimersByTimeAsync(0);
    redis.disconnect();
    await jest.advanceTimersByTimeAsync(10_000);

    expect(redis.readyClient).toBeNull();
    expect(redisConstructor).toHaveBeenCalledTimes(1);
    expect(instances[0].disconnect).toHaveBeenCalledTimes(1);
  });
});
