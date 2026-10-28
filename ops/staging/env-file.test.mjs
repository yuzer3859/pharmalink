// Tests for env-file.mjs. Run: node --test ops/staging/env-file.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  COMPOSE_CONTROLLED,
  fillEnvTemplate,
  generateEnvValues,
  generateOtpHashSecret,
  otpHashSecretProblem,
  parseEnvText,
  validateEnvValues,
} from './env-file.mjs';

const EXAMPLE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend', '.env.example'), 'utf8');
const generatedFile = () => parseEnvText(fillEnvTemplate(EXAMPLE, generateEnvValues()));
const noValueIn = (problems, env) => {
  for (const key of ['POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY', 'OTP_HASH_SECRET']) {
    if (env[key] && env[key].length >= 8) assert.ok(!problems.join('\n').includes(env[key]), `a problem message contains the value of ${key}`);
  }
};

test('.env.example has an active OTP_HASH_SECRET placeholder and does not set OTP_STORE', () => {
  const example = parseEnvText(EXAMPLE);
  assert.equal(example.OTP_HASH_SECRET, 'REPLACE_ME');
  for (const key of COMPOSE_CONTROLLED) assert.ok(!(key in example), `${key} is set in .env.example`);
});

test('--init-env output: every secret generated, valid, distinct, and OTP_HASH_SECRET is 43 base64url characters', () => {
  const env = generatedFile();
  const { problems, port } = validateEnvValues(env);
  assert.deepEqual(problems, []);
  assert.equal(port, 3000);
  assert.match(env.OTP_HASH_SECRET, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(Buffer.from(env.OTP_HASH_SECRET, 'base64url').length, 32);
  const secrets = ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY', 'OTP_HASH_SECRET'].map((k) => env[k]);
  assert.equal(new Set(secrets).size, 4);
  assert.ok(!fillEnvTemplate(EXAMPLE, generateEnvValues()).includes('=REPLACE_ME'));
});

test('each run generates a fresh OTP_HASH_SECRET', () => {
  const seen = new Set(Array.from({ length: 20 }, () => generateEnvValues().OTP_HASH_SECRET));
  assert.equal(seen.size, 20);
});

test('generation retries a candidate that would fail validation', () => {
  const candidates = [Buffer.alloc(32, 0), Buffer.from('a'.repeat(32)), Buffer.from('0123456789abcdefghijklmnopqrstuv')];
  const random = () => candidates.shift();
  assert.equal(generateOtpHashSecret([], random), Buffer.from('0123456789abcdefghijklmnopqrstuv').toString('base64url'));
  assert.throws(() => generateOtpHashSecret([], () => Buffer.alloc(32, 0)), /could not generate/);
});

test('OTP_HASH_SECRET rules match assertOtpHashSecret (Work 60)', () => {
  const good = 'q7Vb2Lx9Rk4Tz1Wm8Np3Hs6Df0Gj5Ya2';
  assert.equal(otpHashSecretProblem(good), null);
  assert.match(otpHashSecretProblem(undefined), /missing/);
  assert.match(otpHashSecretProblem('   '), /missing/);
  assert.match(otpHashSecretProblem(good.slice(0, 31)), /at least 32 characters/);
  assert.match(otpHashSecretProblem(`REPLACE_ME-${good}`), /placeholder/);
  assert.match(otpHashSecretProblem(`${good}changeme`), /placeholder/);
  assert.match(otpHashSecretProblem('abababababababababababababababab'), /placeholder/);
  assert.match(otpHashSecretProblem(good, ['other', good]), /dedicated secret/);
});

test('validation rejects an absent, placeholder, short or reused OTP_HASH_SECRET without echoing it', () => {
  const base = generatedFile();
  const cases = [
    [{ OTP_HASH_SECRET: undefined }, /OTP_HASH_SECRET is missing or still a placeholder/],
    [{ OTP_HASH_SECRET: 'REPLACE_ME' }, /OTP_HASH_SECRET is missing or still a placeholder/],
    [{ OTP_HASH_SECRET: 'short-but-random-Xy7' }, /at least 32 characters/],
    [{ OTP_HASH_SECRET: 'this-is-an-example-secret-value-123456' }, /placeholder/],
    [{ OTP_HASH_SECRET: base.JWT_ACCESS_SECRET }, /dedicated secret/],
    [{ OTP_HASH_SECRET: base.JWT_REFRESH_SECRET }, /dedicated secret/],
    [{ OTP_HASH_SECRET: base.MASTER_ENCRYPTION_KEY }, /dedicated secret/],
  ];
  for (const [override, expected] of cases) {
    const env = { ...base, ...override };
    if (override.OTP_HASH_SECRET === undefined) delete env.OTP_HASH_SECRET;
    const { problems } = validateEnvValues(env);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], expected);
    noValueIn(problems, env);
  }
});

test('values the stack controls are rejected in the env file, including OTP_STORE', () => {
  for (const key of COMPOSE_CONTROLLED) {
    const { problems } = validateEnvValues({ ...generatedFile(), [key]: 'x' });
    assert.deepEqual(problems, [`${key} must not be set in backend/.env.staging; compose.staging.yml sets it (use BACKEND_HOST_PORT for the host port)`]);
  }
  assert.deepEqual(COMPOSE_CONTROLLED, ['DATABASE_URL', 'REDIS_URL', 'NODE_ENV', 'PORT', 'OTP_STORE']);
});

test('the existing checks still apply', () => {
  const base = generatedFile();
  const problemsOf = (override) => validateEnvValues({ ...base, ...override }).problems;
  assert.match(problemsOf({ POSTGRES_PASSWORD: 'has-dash-0123456789' })[0], /POSTGRES_PASSWORD/);
  assert.match(problemsOf({ JWT_ACCESS_SECRET: 'short' })[0], /JWT_ACCESS_SECRET must be at least 16/);
  assert.match(problemsOf({ JWT_REFRESH_SECRET: base.JWT_ACCESS_SECRET })[0], /must differ/);
  assert.match(problemsOf({ MASTER_ENCRYPTION_KEY: 'c2hvcnQ=' })[0], /exactly 32 bytes/);
  assert.match(problemsOf({ BACKEND_HOST_PORT: '70000' })[0], /BACKEND_HOST_PORT/);
});

test('parseEnvText handles comments, blanks, quotes and CRLF', () => {
  assert.deepEqual(parseEnvText('# c\r\n\r\nA=1\r\nB="two"\r\nC=\'three\'\r\n# OTP_STORE=redis\r\n'), { A: '1', B: 'two', C: 'three' });
});
