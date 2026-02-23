/**
 * E2E Client-Side Encryption for Obsidian Plugin
 *
 * Uses Node.js crypto module (available in Electron).
 *
 * Key hierarchy (matches web-ui):
 *   Password → PBKDF2 → wrapping key (AES-256-GCM) → encrypts RSA private key
 *   RSA-OAEP-2048 key pair → encrypts per-vault AES-256-GCM VEKs
 *   VEK → encrypts file content (AES-256-GCM)
 *
 * Content format: "e2e:<iv_base64>:<ciphertext_base64>"
 *   (includes GCM auth tag appended to ciphertext, standard for Web Crypto compat)
 */

import * as crypto from 'crypto';

const PBKDF2_ITERATIONS = 600000;
const AES_KEY_BYTES = 32; // 256 bits
const IV_BYTES = 12;      // 96 bits (GCM standard)
const AUTH_TAG_BYTES = 16;

// ────────────────────── Key Generation ──────────────────────

export interface KeyPairResult {
  publicKey: string;  // base64-encoded SPKI
  privateKey: string; // base64-encoded PKCS8
}

/**
 * Generate an RSA-OAEP 2048-bit key pair.
 */
export function generateKeyPair(): KeyPairResult {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });

  return {
    publicKey: (publicKey as Buffer).toString('base64'),
    privateKey: (privateKey as Buffer).toString('base64'),
  };
}

/**
 * Generate a random 256-bit AES vault key (VEK).
 */
export function generateVaultKey(): Buffer {
  return crypto.randomBytes(AES_KEY_BYTES);
}

// ────────────────────── Key Derivation ──────────────────────

/**
 * Derive an AES-256 wrapping key from a password using PBKDF2.
 */
function deriveKeyFromPassword(
  password: string,
  salt: Buffer,
  iterations: number = PBKDF2_ITERATIONS
): Buffer {
  return crypto.pbkdf2Sync(password, salt, iterations, AES_KEY_BYTES, 'sha256');
}

// ────────────────────── Private Key Encryption ──────────────────────

/**
 * Encrypt an RSA private key (PKCS8 DER, base64) with a password.
 * Format compatible with web-ui: "iv_base64:ciphertext_base64"
 * (GCM auth tag is appended to ciphertext, matching Web Crypto API output)
 */
export function encryptPrivateKey(
  privateKeyB64: string,
  password: string
): { encryptedPrivateKey: string; salt: string; iterations: number } {
  const salt = crypto.randomBytes(16);
  const wrappingKey = deriveKeyFromPassword(password, salt);
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv('aes-256-gcm', wrappingKey, iv);
  const privateKeyBuf = Buffer.from(privateKeyB64, 'base64');
  const encrypted = Buffer.concat([cipher.update(privateKeyBuf), cipher.final()]);
  const authTag = cipher.getAuthTag();

  // Concatenate ciphertext + authTag (matches Web Crypto GCM output)
  const combined = Buffer.concat([encrypted, authTag]);

  return {
    encryptedPrivateKey: `${iv.toString('base64')}:${combined.toString('base64')}`,
    salt: salt.toString('base64'),
    iterations: PBKDF2_ITERATIONS,
  };
}

/**
 * Decrypt an RSA private key using the user's password.
 */
export function decryptPrivateKey(
  encryptedPrivateKey: string,
  password: string,
  salt: string,
  iterations: number = PBKDF2_ITERATIONS
): string {
  const [ivB64, combinedB64] = encryptedPrivateKey.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const combined = Buffer.from(combinedB64, 'base64');
  const saltBuf = Buffer.from(salt, 'base64');

  // Split ciphertext and auth tag
  const ciphertext = combined.subarray(0, combined.length - AUTH_TAG_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);

  const wrappingKey = deriveKeyFromPassword(password, saltBuf, iterations);

  const decipher = crypto.createDecipheriv('aes-256-gcm', wrappingKey, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return decrypted.toString('base64'); // Return PKCS8 DER as base64
}

// ────────────────────── Vault Key Encryption ──────────────────────

/**
 * Encrypt a vault key (VEK) with a user's RSA public key (SPKI base64).
 */
export function encryptVaultKeyForUser(
  vek: Buffer,
  publicKeyB64: string
): string {
  const publicKey = crypto.createPublicKey({
    key: Buffer.from(publicKeyB64, 'base64'),
    format: 'der',
    type: 'spki',
  });

  const encrypted = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    vek
  );

  return encrypted.toString('base64');
}

/**
 * Decrypt a vault key (VEK) using the user's RSA private key (PKCS8 base64).
 */
export function decryptVaultKey(
  encryptedVaultKeyB64: string,
  privateKeyB64: string
): Buffer {
  const privateKey = crypto.createPrivateKey({
    key: Buffer.from(privateKeyB64, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });

  return crypto.privateDecrypt(
    { key: privateKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    Buffer.from(encryptedVaultKeyB64, 'base64')
  );
}

// ────────────────────── Content Encryption ──────────────────────

/**
 * Encrypt plaintext content using AES-256-GCM with a vault key.
 * Returns: "e2e:<iv_base64>:<ciphertext+authTag_base64>"
 */
export function encryptContent(plaintext: string, vek: Buffer): string {
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv('aes-256-gcm', vek, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  // Concatenate ciphertext + authTag (matches Web Crypto GCM output)
  const combined = Buffer.concat([encrypted, authTag]);

  return `e2e:${iv.toString('base64')}:${combined.toString('base64')}`;
}

/**
 * Decrypt content encrypted with encryptContent.
 * Expects format: "e2e:<iv_base64>:<ciphertext+authTag_base64>"
 */
export function decryptContent(ciphertext: string, vek: Buffer): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3 || parts[0] !== 'e2e') {
    throw new Error('Invalid E2E encrypted content format');
  }

  const iv = Buffer.from(parts[1], 'base64');
  const combined = Buffer.from(parts[2], 'base64');

  // Split ciphertext and auth tag
  const encrypted = combined.subarray(0, combined.length - AUTH_TAG_BYTES);
  const authTag = combined.subarray(combined.length - AUTH_TAG_BYTES);

  const decipher = crypto.createDecipheriv('aes-256-gcm', vek, iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);

  return decrypted.toString('utf8');
}

/**
 * Check whether a string looks like E2E-encrypted content.
 */
export function isE2EEncrypted(content: string): boolean {
  return content.startsWith('e2e:');
}
