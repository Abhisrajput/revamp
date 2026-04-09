/**
 * AES-256-GCM encryption for storing sensitive credentials (BYOK API keys).
 *
 * Uses a dedicated CREDENTIAL_ENCRYPTION_KEY env var (required) to encrypt
 * credentials before persisting to the project settings JSONB column.
 * Each encrypted value gets a unique random IV and salt.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const AUTH_TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;

// Explicit scrypt cost parameters for auditability
const SCRYPT_OPTIONS = { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 };

/**
 * Get the encryption secret. Requires CREDENTIAL_ENCRYPTION_KEY.
 * Does NOT fall back to JWT_SECRET to maintain key separation.
 */
function getSecret(): string {
  const secret = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!secret) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY must be set for credential encryption. " +
      "Generate one with: openssl rand -hex 32"
    );
  }
  return secret;
}

/**
 * Derive a 256-bit key from the server secret and a random salt.
 */
function deriveKey(salt: Buffer): Buffer {
  const secret = getSecret();
  return scryptSync(secret, salt, KEY_LENGTH, SCRYPT_OPTIONS);
}

/**
 * Encrypt a plaintext string.
 * Returns a base64 string containing: salt (16) + IV (16) + authTag (16) + ciphertext.
 */
export function encryptCredential(plaintext: string): string {
  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Pack: salt (16) + IV (16) + authTag (16) + ciphertext
  const packed = Buffer.concat([salt, iv, authTag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded encrypted credential.
 */
export function decryptCredential(encryptedBase64: string): string {
  const packed = Buffer.from(encryptedBase64, "base64");

  const salt = packed.subarray(0, SALT_LENGTH);
  const iv = packed.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const authTag = packed.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);
  const ciphertext = packed.subarray(SALT_LENGTH + IV_LENGTH + AUTH_TAG_LENGTH);

  const key = deriveKey(salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return decrypted.toString("utf8");
}

/**
 * Encrypt all credential fields in an LLM provider config object.
 * Only encrypts non-empty string values for known sensitive keys.
 */
const SENSITIVE_KEYS = ["api_key", "aws_access_key_id", "aws_secret_access_key", "aws_session_token"];

export function encryptProviderCredentials(provider: Record<string, unknown>): Record<string, unknown> {
  const result = { ...provider };
  for (const key of SENSITIVE_KEYS) {
    const val = result[key];
    if (typeof val === "string" && val.length > 0) {
      result[key] = encryptCredential(val);
    }
  }
  return result;
}

/**
 * Decrypt all credential fields in an LLM provider config object.
 * Throws on decryption failure — does NOT silently pass through plaintext.
 */
export function decryptProviderCredentials(provider: Record<string, unknown>): Record<string, unknown> {
  const result = { ...provider };
  for (const key of SENSITIVE_KEYS) {
    const val = result[key];
    if (typeof val === "string" && val.length > 0) {
      try {
        result[key] = decryptCredential(val);
      } catch (err) {
        console.error(`[Crypto] Failed to decrypt credential field "${key}" — value may be corrupted or key may have changed`);
        throw new Error(`Credential decryption failed for field "${key}". Check CREDENTIAL_ENCRYPTION_KEY.`);
      }
    }
  }
  return result;
}

/**
 * Mask a credential for display (show last 4 chars).
 */
export function maskCredential(value: string): string {
  if (value.length <= 4) return "****";
  return "****" + value.slice(-4);
}
