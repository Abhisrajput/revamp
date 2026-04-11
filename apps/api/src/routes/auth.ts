import { FastifyInstance } from "fastify";
import type { UserRole } from "@/plugins/auth.js";
import { z } from "zod";
import crypto from "crypto";
import bcrypt from "bcryptjs";
import { db } from "@/db/index.js";
import { users, organizations } from "@/db/schema.js";
import { eq } from "drizzle-orm";

const BCRYPT_ROUNDS = 12;
/** OTP validity window in milliseconds (10 minutes) */
const OTP_EXPIRY_MS = 10 * 60 * 1000;
/** Password reset token validity window in milliseconds (1 hour) */
const RESET_TOKEN_EXPIRY_MS = 60 * 60 * 1000;

// Redis-backed reset token store (survives restarts, works multi-instance).
// Falls back to in-memory Map when Redis is unavailable.
import Redis from "ioredis";

const RESET_TOKEN_PREFIX = "revamp:reset:";
let _redis: Redis | null = null;
function getRedis(): Redis | null {
  if (_redis) return _redis;
  const url = process.env.REDIS_URL;
  if (!url) return null;
  try {
    _redis = new Redis(url, { maxRetriesPerRequest: 1, connectTimeout: 2000, lazyConnect: true });
    _redis.connect().catch(() => { _redis = null; });
    return _redis;
  } catch { return null; }
}

// In-memory fallback when Redis is unavailable
const resetTokenMapFallback = new Map<string, { token: string; expiry: number; userId: string }>();
setInterval(() => {
  const now = Date.now();
  for (const [email, data] of resetTokenMapFallback) {
    if (now > data.expiry) resetTokenMapFallback.delete(email);
  }
}, 15 * 60 * 1000).unref();

const resetTokenStore = {
  async set(email: string, data: { token: string; expiry: number; userId: string }) {
    const redis = getRedis();
    if (redis) {
      const ttlSec = Math.ceil((data.expiry - Date.now()) / 1000);
      await redis.set(RESET_TOKEN_PREFIX + email, JSON.stringify(data), "EX", ttlSec).catch(() => {
        resetTokenMapFallback.set(email, data); // fallback
      });
    } else {
      resetTokenMapFallback.set(email, data);
    }
  },
  async get(email: string): Promise<{ token: string; expiry: number; userId: string } | undefined> {
    const redis = getRedis();
    if (redis) {
      try {
        const raw = await redis.get(RESET_TOKEN_PREFIX + email);
        return raw ? JSON.parse(raw) : undefined;
      } catch { return resetTokenMapFallback.get(email); }
    }
    return resetTokenMapFallback.get(email);
  },
  async delete(email: string) {
    const redis = getRedis();
    if (redis) await redis.del(RESET_TOKEN_PREFIX + email).catch(() => {});
    resetTokenMapFallback.delete(email);
  },
};

/** Set JWT as HttpOnly cookie on auth responses. Prevents XSS token theft. */
function setAuthCookie(reply: import("fastify").FastifyReply, token: string) {
  const isProduction = process.env.NODE_ENV === 'production';
  reply.header('Set-Cookie',
    `revamp-token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${isProduction ? '; Secure' : ''}`
  );
}

/** Clear the auth cookie on logout. */
function clearAuthCookie(reply: import("fastify").FastifyReply) {
  reply.header('Set-Cookie', 'revamp-token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}

const SignInSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
});

const SignUpSchema = z.object({
  email: z.string().email(),
  password: z.string().min(8),
  first_name: z.string(),
  last_name: z.string(),
  organization_name: z.string().optional(),
});

const OTPGenerateSchema = z.object({
  email: z.string().email(),
});

const OTPVerifySchema = z.object({
  email: z.string().email(),
  otp: z.string().length(6),
});

const ResetPasswordRequestSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordVerifySchema = z.object({
  email: z.string().email(),
  token: z.string(),
});

const ResetPasswordConfirmSchema = z.object({
  email: z.string().email(),
  token: z.string(),
  new_password: z.string().min(8),
});

// Legacy schema kept for backward compatibility
const OTPSchema = z.object({
  email: z.string().email(),
});

const ResetPasswordSchema = z.object({
  email: z.string().email(),
  token: z.string(),
  new_password: z.string().min(8),
});

// ─── HELPERS ────────────────────────────────────────────────────

/**
 * Generate a 6-digit TOTP-like OTP.
 * Uses HMAC-SHA256 with user's otp_secret and a time-based counter.
 */
function generateOTP(secret: string): string {
  const counter = Math.floor(Date.now() / OTP_EXPIRY_MS);
  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(counter.toString());
  const hash = hmac.digest("hex");
  // Extract 6-digit code from hash
  const offset = parseInt(hash.slice(-1), 16);
  const code = (parseInt(hash.slice(offset * 2, offset * 2 + 8), 16) % 1000000)
    .toString()
    .padStart(6, "0");
  return code;
}

/**
 * Verify a 6-digit OTP against the user's secret.
 * Checks current window and previous window to handle clock drift.
 */
function verifyOTP(secret: string, otp: string): boolean {
  const currentCounter = Math.floor(Date.now() / OTP_EXPIRY_MS);

  // Check current and previous window
  for (const counter of [currentCounter, currentCounter - 1]) {
    const hmac = crypto.createHmac("sha256", secret);
    hmac.update(counter.toString());
    const hash = hmac.digest("hex");
    const offset = parseInt(hash.slice(-1), 16);
    const expectedCode = (parseInt(hash.slice(offset * 2, offset * 2 + 8), 16) % 1000000)
      .toString()
      .padStart(6, "0");
    if (expectedCode === otp) return true;
  }
  return false;
}

/**
 * Generate a secure random token for password reset.
 */
function generateResetToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/**
 * Timing-safe string comparison to prevent timing attacks on token validation.
 * Falls back to false when lengths differ (leaks length, but tokens are fixed-size).
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Try to send an email via the email service. Logs warning if unavailable.
 * Never logs token/OTP values — only the type and a redacted indicator.
 */
async function trySendEmail(
  type: "otp" | "password_reset",
  email: string,
  data: Record<string, string>,
): Promise<void> {
  try {
    const { emailService } = await import("@/services/email.js");
    if (type === "otp") {
      await emailService.sendOTP(email, data.otp);
    } else if (type === "password_reset") {
      await emailService.sendPasswordReset(email, data.token);
    }
  } catch {
    // Email service not configured — log warning but never log token/OTP values
    console.warn(`[Auth] Email service unavailable — ${type} email not sent`);
  }
}

export async function authRoutes(fastify: FastifyInstance) {
  // Tight per-route rate limits on sensitive auth endpoints.
  // These override the global rate-limit plugin config for these routes.
  const isDev = process.env.NODE_ENV !== "production";
  const loginRateLimit = { config: { rateLimit: { max: isDev ? 200 : 10, timeWindow: "15 minutes" } } };
  const otpRateLimit = { config: { rateLimit: { max: isDev ? 100 : 5, timeWindow: "15 minutes" } } };
  const resetRateLimit = { config: { rateLimit: { max: isDev ? 100 : 5, timeWindow: "15 minutes" } } };
  const signupRateLimit = { config: { rateLimit: { max: isDev ? 200 : 10, timeWindow: "1 hour" } } };

  fastify.post<{ Body: z.infer<typeof SignInSchema> }>("/auth/login", loginRateLimit, async (request, reply) => {
    const validation = SignInSchema.safeParse(request.body);
    if (!validation.success) {
      return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
    }

    const { email, password } = validation.data;

    try {
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (user) {
        const passwordValid = await bcrypt.compare(password, user.password_hash ?? "");
        if (!passwordValid) {
          return reply.status(401).send({ error: "Invalid credentials" });
        }

        if (!user.is_active) {
          return reply.status(403).send({ error: "Account is disabled" });
        }

        await db
          .update(users)
          .set({ last_login: new Date() })
          .where(eq(users.id, user.id));

        const token = fastify.jwt.sign({
          sub: user.id,
          email: user.email,
          role: user.role as UserRole,
          organization_id: user.organization_id ?? "",
        });

        setAuthCookie(reply, token);
        return reply.send({
          token, // Still in body for backward compatibility during migration
          user: {
            id: user.id,
            email: user.email,
            first_name: user.first_name,
            last_name: user.last_name,
            role: user.role,
            organization_id: user.organization_id,
          },
        });
      }
    } catch (dbError) {
      fastify.log.error(dbError, "Database error during login");
      return reply.status(500).send({ error: "Internal server error" });
    }

    return reply.status(401).send({ error: "Invalid credentials" });
  });

  fastify.post<{ Body: z.infer<typeof SignUpSchema> }>("/auth/signup", signupRateLimit, async (request, reply) => {
    const validation = SignUpSchema.safeParse(request.body);
    if (!validation.success) {
      return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
    }

    const { email, password, first_name, last_name, organization_name } = validation.data;

    // Check if user exists
    const existingUser = await db.query.users.findFirst({
      where: eq(users.email, email),
    });

    if (existingUser) {
      return reply.status(409).send({ error: "Email already registered" });
    }

    // Hash password before entering transaction
    const userId = crypto.randomUUID();
    const hashedPassword = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Create org + user atomically so a partial failure leaves no orphaned rows
    let organizationId: string | null = null;

    await db.transaction(async (tx) => {
      if (organization_name) {
        const slug = organization_name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .substring(0, 63);

        const org = await tx
          .insert(organizations)
          .values({
            id: crypto.randomUUID(),
            name: organization_name,
            slug,
            owner_id: userId,
          })
          .returning();

        organizationId = org[0]?.id || null;
      }

      await tx.insert(users).values({
        id: userId,
        email,
        password_hash: hashedPassword,
        first_name,
        last_name,
        organization_id: organizationId,
        role: "developer",
      });
    });

    const token = fastify.jwt.sign({
      sub: userId,
      email,
      role: "developer",
      organization_id: organizationId ?? "",
    });

    setAuthCookie(reply, token);
    return reply.status(201).send({
      token,
      user: {
        id: userId,
        email,
        first_name,
        last_name,
        role: "developer",
        organization_id: organizationId,
      },
    });
  });

  // ── OTP Generation ─────────────────────────────────────────────
  // Generates a 6-digit OTP, stores the secret on the user, and sends via email.
  fastify.post<{ Body: z.infer<typeof OTPGenerateSchema> }>(
    "/auth/otp/generate",
    otpRateLimit,
    async (request, reply) => {
      const validation = OTPGenerateSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const { email } = validation.data;
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (!user) {
        // Return success even for non-existent users to prevent email enumeration
        return reply.send({ message: "If the email exists, an OTP has been sent" });
      }

      // Generate or reuse OTP secret
      let otpSecret = user.otp_secret;
      if (!otpSecret) {
        otpSecret = crypto.randomBytes(32).toString("hex");
        await db.update(users).set({ otp_secret: otpSecret }).where(eq(users.id, user.id));
      }

      const otp = generateOTP(otpSecret);

      // Send OTP via email (non-blocking, logs warning if email service unavailable)
      await trySendEmail("otp", email, { otp });

      return reply.send({ message: "If the email exists, an OTP has been sent" });
    },
  );

  // ── OTP Verification ──────────────────────────────────────────
  // Verifies the OTP and returns a JWT token if valid.
  fastify.post<{ Body: z.infer<typeof OTPVerifySchema> }>(
    "/auth/otp/verify",
    otpRateLimit,
    async (request, reply) => {
      const validation = OTPVerifySchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const { email, otp } = validation.data;
      const user = await db.query.users.findFirst({
        where: eq(users.email, email),
      });

      if (!user || !user.otp_secret) {
        return reply.status(401).send({ error: "Invalid OTP" });
      }

      if (!user.is_active) {
        return reply.status(403).send({ error: "Account is disabled" });
      }

      const isValid = verifyOTP(user.otp_secret, otp);
      if (!isValid) {
        return reply.status(401).send({ error: "Invalid or expired OTP" });
      }

      // Update last login
      await db.update(users).set({ last_login: new Date() }).where(eq(users.id, user.id));

      const token = fastify.jwt.sign({
        sub: user.id,
        email: user.email,
        role: user.role as UserRole,
        organization_id: user.organization_id ?? "",
      });

      setAuthCookie(reply, token);
      return reply.send({
        token,
        user: {
          id: user.id,
          email: user.email,
          first_name: user.first_name,
          last_name: user.last_name,
          role: user.role,
          organization_id: user.organization_id,
        },
      });
    },
  );

  // Legacy OTP endpoint — backward compatible
  fastify.post<{ Body: z.infer<typeof OTPSchema> }>("/auth/otp", async (request, reply) => {
    const validation = OTPSchema.safeParse(request.body);
    if (!validation.success) {
      return reply.status(400).send({ error: "Invalid input" });
    }

    // Delegate to /auth/otp/generate
    const { email } = validation.data;
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    if (user) {
      let otpSecret = user.otp_secret;
      if (!otpSecret) {
        otpSecret = crypto.randomBytes(32).toString("hex");
        await db.update(users).set({ otp_secret: otpSecret }).where(eq(users.id, user.id));
      }
      const otp = generateOTP(otpSecret);
      await trySendEmail("otp", email, { otp });
    }
    return reply.send({ message: "OTP sent to email" });
  });

  // ── Password Reset: Request ───────────────────────────────────
  // Generates a reset token, stores it in the in-memory resetTokenStore, sends email.
  fastify.post<{ Body: z.infer<typeof ResetPasswordRequestSchema> }>(
    "/auth/reset-password/request",
    resetRateLimit,
    async (request, reply) => {
      const validation = ResetPasswordRequestSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const { email } = validation.data;
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });

      if (!user) {
        // Prevent email enumeration
        return reply.send({ message: "If the email exists, a reset link has been sent" });
      }

      const token = generateResetToken();
      const expiry = Date.now() + RESET_TOKEN_EXPIRY_MS;

      // Store reset token — Redis with in-memory fallback
      await resetTokenStore.set(email, { token, expiry, userId: user.id });

      await trySendEmail("password_reset", email, { token });

      return reply.send({ message: "If the email exists, a reset link has been sent" });
    },
  );

  // ── Password Reset: Verify Token ──────────────────────────────
  // Validates that the reset token is correct and not expired.
  fastify.post<{ Body: z.infer<typeof ResetPasswordVerifySchema> }>(
    "/auth/reset-password/verify",
    async (request, reply) => {
      const validation = ResetPasswordVerifySchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const { email, token } = validation.data;

      const resetData = await resetTokenStore.get(email);
      if (
        !resetData ||
        !safeCompare(resetData.token, token) ||
        Date.now() > resetData.expiry
      ) {
        return reply.status(400).send({ error: "Invalid or expired reset token" });
      }

      return reply.send({ valid: true });
    },
  );

  // ── Password Reset: Confirm ───────────────────────────────────
  // Validates the token and updates the password.
  fastify.post<{ Body: z.infer<typeof ResetPasswordConfirmSchema> }>(
    "/auth/reset-password/confirm",
    resetRateLimit,
    async (request, reply) => {
      const validation = ResetPasswordConfirmSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input", details: validation.error.errors });
      }

      const { email, token, new_password } = validation.data;

      const resetData = await resetTokenStore.get(email);
      if (
        !resetData ||
        !safeCompare(resetData.token, token) ||
        Date.now() > resetData.expiry
      ) {
        return reply.status(400).send({ error: "Invalid or expired reset token" });
      }

      // Update password — otp_secret is no longer touched by the reset flow
      const hashedNewPassword = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
      await db
        .update(users)
        .set({
          password_hash: hashedNewPassword,
          updated_at: new Date(),
        })
        .where(eq(users.id, resetData.userId));

      // Remove consumed token
      await resetTokenStore.delete(email);

      return reply.send({ message: "Password reset successfully" });
    },
  );

  // Legacy reset-password endpoint — backward compatible
  fastify.post<{ Body: z.infer<typeof ResetPasswordSchema> }>(
    "/auth/reset-password",
    async (request, reply) => {
      const validation = ResetPasswordSchema.safeParse(request.body);
      if (!validation.success) {
        return reply.status(400).send({ error: "Invalid input" });
      }

      const { email, token, new_password } = validation.data;

      const resetData = await resetTokenStore.get(email);
      if (
        !resetData ||
        !safeCompare(resetData.token, token) ||
        Date.now() > resetData.expiry
      ) {
        return reply.status(400).send({ error: "Invalid or expired reset token" });
      }

      const hashedNewPassword = await bcrypt.hash(new_password, BCRYPT_ROUNDS);
      await db
        .update(users)
        .set({ password_hash: hashedNewPassword })
        .where(eq(users.id, resetData.userId));

      // Remove consumed token
      await resetTokenStore.delete(email);

      return reply.send({ message: "Password reset successfully" });
    },
  );

  // Verify token endpoint
  fastify.get("/auth/verify", { onRequest: [fastify.authenticate] }, async (request, reply) => {
    return reply.send({
      valid: true,
      user: request.user,
    });
  });
}
