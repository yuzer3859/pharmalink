// PharmaLink — the local staging env file (backend/.env.staging): generation and validation.
// Used by rehearse-clean-install.mjs; tested by env-file.test.mjs (`node --test ops/staging/env-file.test.mjs`).
// Pure functions, no I/O, and no message ever contains a value from the file.

import { randomBytes } from 'node:crypto';

// compose.staging.yml sets these for the backend itself, so a value in the env file would be
// silently overridden. They are rejected so nobody believes the stack used the value they wrote.
export const COMPOSE_CONTROLLED = ['DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'PORT', 'OTP_STORE'];

export const REQUIRED_SECRETS = ['POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY', 'OTP_HASH_SECRET'];

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

/** Random local-only values for every REPLACE_ME secret in backend/.env.example. */
export function generateEnvValues(random = randomBytes) {
  const values = {
    POSTGRES_PASSWORD: random(24).toString('hex'),
    JWT_ACCESS_SECRET: random(32).toString('hex'),
    JWT_REFRESH_SECRET: random(32).toString('hex'),
    MASTER_ENCRYPTION_KEY: random(32).toString('base64'),
  };
  values.OTP_HASH_SECRET = generateOtpHashSecret([values.JWT_ACCESS_SECRET, values.JWT_REFRESH_SECRET, values.MASTER_ENCRYPTION_KEY], random);
  return values;
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

/** Validates a parsed env file. Returns { problems, port }; problems name keys, never values. */
export function validateEnvValues(env, fileLabel = 'backend/.env.staging') {
  const problems = [];
  for (const key of REQUIRED_SECRETS) {
    if (!env[key] || env[key].includes('REPLACE_ME')) problems.push(`${key} is missing or still a placeholder`);
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
  for (const key of COMPOSE_CONTROLLED) {
    if (key in env) problems.push(`${key} must not be set in ${fileLabel}; compose.staging.yml sets it (use BACKEND_HOST_PORT for the host port)`);
  }
  const port = Number(env.BACKEND_HOST_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) problems.push('BACKEND_HOST_PORT must be a port number');
  return { problems, port };
}
