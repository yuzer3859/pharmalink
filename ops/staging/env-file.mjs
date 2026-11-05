// PharmaLink — the local staging env file (backend/.env.staging): generation and validation.
// Used by rehearse-clean-install.mjs; tested by env-file.test.mjs (`node --test ops/staging/env-file.test.mjs`).
// Pure functions, no I/O, and no message ever contains a value from the file.

import { randomBytes } from 'node:crypto';

// compose.staging.yml sets these for the backend itself, so a value in the env file would be
// silently overridden. They are rejected so nobody believes the stack used the value they wrote.
export const COMPOSE_CONTROLLED = ['DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'PORT', 'OTP_STORE'];

export const REQUIRED_SECRETS = ['POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY', 'OTP_HASH_SECRET', 'ADMIN_MFA_ENCRYPTION_KEY'];

// Keys ensure-env-secrets.mjs may add to an existing env file when they are missing (Work 68).
// Only keys whose absence is safe to fill with a fresh random value: nothing has been encrypted
// under a key that never existed. A key that is present is never replaced.
export const ADDABLE_SECRETS = ['ADMIN_MFA_ENCRYPTION_KEY'];

// Mirrors assertOtpHashSecret in backend/src/shared/config/otp.config.ts (Work 60), which the
// backend applies again at boot. Kept here so a bad file fails before anything is built.
export const MIN_OTP_HASH_SECRET_LENGTH = 32;
const PLACEHOLDER_SECRET = /replace[_-]?me|change[_-]?me|placeholder|example/i;

/** Returns a problem description for an unusable OTP_HASH_SECRET, or null. Never the value. */
export function otpHashSecretProblem(secret, otherSecrets = []) {
  const value = typeof secret === 'string' ? secret.trim() : '';
  if (!value) return 'OTP_HASH_SECRET is missing';
  if (value.length < MIN_OTP_HASH_SECRET_LENGTH) return `OTP_HASH_SECRET must be at least ${MIN_OTP_HASH_SECRET_LENGTH} characters`;
  if (PLACEHOLDER_SECRET.test(value) || new Set(value).size < 8) return 'OTP_HASH_SECRET looks like a placeholder; generate a random value';
  if (otherSecrets.some((other) => typeof other === 'string' && other.trim() === value)) {
    return 'OTP_HASH_SECRET must be a dedicated secret, not a copy of JWT_ACCESS_SECRET, JWT_REFRESH_SECRET or MASTER_ENCRYPTION_KEY';
  }
  return null;
}

/** A fresh OTP_HASH_SECRET: 32 CSPRNG bytes, base64url (43 characters), checked like any other. */
export function generateOtpHashSecret(otherSecrets = [], random = randomBytes) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const secret = random(32).toString('base64url');
    if (otpHashSecretProblem(secret, otherSecrets) === null) return secret;
  }
  throw new Error('could not generate a usable OTP_HASH_SECRET');
}

// Mirrors decodeAdminMfaKey in backend/src/shared/config/admin-mfa.config.ts (Work 66), which the
// backend applies again at boot: 32 bytes in standard, padded base64 (44 characters).
export const ADMIN_MFA_KEY_BYTES = 32;
const BASE64_32_BYTES = /^[A-Za-z0-9+/]{43}=$/;

/** Returns a problem description for an unusable ADMIN_MFA_ENCRYPTION_KEY, or null. Never the value. */
export function adminMfaKeyProblem(key, otherSecrets = []) {
  const value = typeof key === 'string' ? key.trim() : '';
  if (!value) return 'ADMIN_MFA_ENCRYPTION_KEY is missing';
  if (!BASE64_32_BYTES.test(value)) return `ADMIN_MFA_ENCRYPTION_KEY must be standard base64 of exactly ${ADMIN_MFA_KEY_BYTES} bytes (44 characters)`;
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== ADMIN_MFA_KEY_BYTES) return `ADMIN_MFA_ENCRYPTION_KEY must decode to exactly ${ADMIN_MFA_KEY_BYTES} bytes`;
  if (new Set(bytes).size < 16) return 'ADMIN_MFA_ENCRYPTION_KEY looks like a placeholder; generate 32 random bytes';
  if (otherSecrets.some((other) => typeof other === 'string' && other.trim() === value)) {
    return 'ADMIN_MFA_ENCRYPTION_KEY must be a dedicated secret, not a copy of JWT_ACCESS_SECRET, JWT_REFRESH_SECRET, MASTER_ENCRYPTION_KEY or OTP_HASH_SECRET';
  }
  return null;
}

/** A fresh ADMIN_MFA_ENCRYPTION_KEY: 32 CSPRNG bytes, standard base64, checked like any other. */
export function generateAdminMfaKey(otherSecrets = [], random = randomBytes) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const key = random(ADMIN_MFA_KEY_BYTES).toString('base64');
    if (adminMfaKeyProblem(key, otherSecrets) === null) return key;
  }
  throw new Error('could not generate a usable ADMIN_MFA_ENCRYPTION_KEY');
}

/** The secrets ADMIN_MFA_ENCRYPTION_KEY must not copy, from a parsed env file or generated values. */
export const adminMfaOtherSecrets = (env) => [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.MASTER_ENCRYPTION_KEY, env.OTP_HASH_SECRET];

/** Random local-only values for every REPLACE_ME secret in backend/.env.example, plus ADDABLE_SECRETS. */
export function generateEnvValues(random = randomBytes) {
  const values = {
    POSTGRES_PASSWORD: random(24).toString('hex'),
    JWT_ACCESS_SECRET: random(32).toString('hex'),
    JWT_REFRESH_SECRET: random(32).toString('hex'),
    MASTER_ENCRYPTION_KEY: random(32).toString('base64'),
  };
  values.OTP_HASH_SECRET = generateOtpHashSecret([values.JWT_ACCESS_SECRET, values.JWT_REFRESH_SECRET, values.MASTER_ENCRYPTION_KEY], random);
  values.ADMIN_MFA_ENCRYPTION_KEY = generateAdminMfaKey(adminMfaOtherSecrets(values), random);
  return values;
}

/** Keys with an active `KEY=` line (any value, even empty); commented-out lines don't count. */
export function assignedKeys(text) {
  return new Set([...text.matchAll(/^[ \t]*([A-Za-z_][A-Za-z0-9_]*)[ \t]*=/gm)].map((m) => m[1]));
}

/**
 * Appends `KEY=value` for each key in `values` that has no active line in `original` (a Buffer),
 * and returns { bytes, added }. The original bytes are kept exactly, as a prefix of the result: a
 * key that is present (even empty or invalid) is never touched, so nothing is ever overwritten or
 * rotated. The file's line ending is reused. Running it again with the result adds nothing.
 */
export function appendMissingEnvValues(original, values) {
  const text = original.toString('utf8');
  const present = assignedKeys(text);
  const added = Object.keys(values).filter((key) => !present.has(key) && values[key]);
  if (!added.length) return { bytes: original, added };
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const separator = text.length && !text.endsWith('\n') ? eol : '';
  const block = ['# Added by ops/staging/ensure-env-secrets.mjs (Work 68). Never rotate it while administrators are enrolled.', ...added.map((key) => `${key}=${values[key]}`)];
  return { bytes: Buffer.concat([original, Buffer.from(`${separator}${block.join(eol)}${eol}`, 'utf8')]), added };
}

/** Replaces each active `KEY=REPLACE_ME` line whose key has a value; everything else is kept. */
export function fillEnvTemplate(example, values) {
  return example.replace(/^([A-Z_]+)=REPLACE_ME$/gm, (line, key) => (values[key] ? `${key}=${values[key]}` : line));
}

export function parseEnvText(text) {
  const env = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[line.slice(0, eq).trim()] = value;
  }
  return env;
}

/**
 * Whether the optional Resend sender is configured (Work 62): both keys set and a sender with an
 * address, the same rule as the backend's ResendConfig. Work 80 adds one check the backend does
 * not make: the key must look like a Resend API key (`re_…`), so a pasted webhook secret
 * (`whsec_…`) or another provider's key is caught here instead of failing at the first send.
 * Values are never returned or printed.
 */
export function emailProviderState(env) {
  const key = (env.RESEND_API_KEY ?? '').trim();
  const from = (env.RESEND_FROM_EMAIL ?? '').trim();
  if (!key && !from) return { configured: false, problem: null };
  if (!key || !from) return { configured: false, problem: 'RESEND_API_KEY and RESEND_FROM_EMAIL must be set together (or both left unset)' };
  if (key.includes('REPLACE_ME') || from.includes('REPLACE_ME')) return { configured: false, problem: 'RESEND_API_KEY or RESEND_FROM_EMAIL is still a placeholder' };
  if (!key.startsWith('re_')) return { configured: false, problem: 'RESEND_API_KEY must be a Resend API key (it starts with "re_")' };
  if (!from.includes('@')) return { configured: false, problem: 'RESEND_FROM_EMAIL must be a sender address, e.g. "PharmaLink <otp@your-verified-domain>"' };
  return { configured: true, problem: null };
}

/** Validates a parsed env file. Returns { problems, port }; problems name keys, never values. */
export function validateEnvValues(env, fileLabel = 'backend/.env.staging') {
  const problems = [];
  for (const key of REQUIRED_SECRETS) {
    if (!env[key] || env[key].includes('REPLACE_ME')) {
      const hint = ADDABLE_SECRETS.includes(key) && !(key in env) ? ' (add it with: node ops/staging/ensure-env-secrets.mjs)' : '';
      problems.push(`${key} is missing or still a placeholder${hint}`);
    }
  }
  if (env.POSTGRES_PASSWORD && !/^[A-Za-z0-9]{16,}$/.test(env.POSTGRES_PASSWORD)) problems.push('POSTGRES_PASSWORD must be at least 16 letters/digits');
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (env[key] && env[key].length < 16) problems.push(`${key} must be at least 16 characters`);
  }
  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (env.MASTER_ENCRYPTION_KEY && Buffer.from(env.MASTER_ENCRYPTION_KEY, 'base64').length !== 32) problems.push('MASTER_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  if (env.OTP_HASH_SECRET && !env.OTP_HASH_SECRET.includes('REPLACE_ME')) {
    const problem = otpHashSecretProblem(env.OTP_HASH_SECRET, [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.MASTER_ENCRYPTION_KEY]);
    if (problem) problems.push(problem);
  }
  if (env.ADMIN_MFA_ENCRYPTION_KEY && !env.ADMIN_MFA_ENCRYPTION_KEY.includes('REPLACE_ME')) {
    const problem = adminMfaKeyProblem(env.ADMIN_MFA_ENCRYPTION_KEY, adminMfaOtherSecrets(env));
    if (problem) problems.push(problem);
  }
  for (const key of COMPOSE_CONTROLLED) {
    if (key in env) problems.push(`${key} must not be set in ${fileLabel}; compose.staging.yml sets it (use BACKEND_HOST_PORT for the host port)`);
  }
  const email = emailProviderState(env);
  if (email.problem) problems.push(email.problem);
  const port = Number(env.BACKEND_HOST_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('BACKEND_HOST_PORT must be a port number');
  return { problems, port };
}
