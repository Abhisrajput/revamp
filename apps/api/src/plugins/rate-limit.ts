import { FastifyInstance, FastifyRequest } from "fastify";
import fastifyRateLimit from "@fastify/rate-limit";
import Redis from "ioredis";
import fp from "fastify-plugin";

export const rateLimitPlugin = fp(async function rateLimitPlugin(fastify: FastifyInstance) {
  const redisUrl = process.env.REDIS_URL;
  let redisConfig: Record<string, any> = {};

  if (redisUrl) {
    let redis: Redis | null = null;
    try {
      redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        connectTimeout: 2000,
        lazyConnect: true,
      });
      // Race connection against a tight timeout so a slow/unreachable Redis
      // doesn't block server startup for the full connectTimeout duration.
      await Promise.race([
        redis.connect(),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Redis connect timeout (startup)")), 2000),
        ),
      ]);
      redisConfig = { redis };
      fastify.log.info("Rate-limit connected to Redis");
    } catch (err) {
      redis?.disconnect();
      fastify.log.warn("Redis unavailable for rate-limit — using in-memory store");
    }
  }

  await fastify.register(fastifyRateLimit, {
    max: parseInt(process.env.RATE_LIMIT_MAX || "100", 10),
    timeWindow: parseInt(process.env.RATE_LIMIT_TIMEWINDOW || "900000", 10), // 15 minutes
    ...redisConfig,
    skip: (request: FastifyRequest) => {
      return request.url === "/health";
    },
  } as any);
});
