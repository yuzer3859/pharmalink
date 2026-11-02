// Tests for env-file.mjs. Run: node --test ops/staging/env-file.test.mjs
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  ADDABLE_SECRETS,
  adminMfaKeyProblem,
  appendMissingEnvValues,
  COMPOSE_CONTROLLED,
  emailProviderState,
  fillEnvTemplate,
  generateAdminMfaKey,
  generateEnvValues,
  generateOtpHashSecret,
  otpHashSecretProblem,
  parseEnvText,
  validateEnvValues,
} from './env-file.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = readFileSync(join(HERE, '..', '..', 'backend', '.env.example'), 'utf8');
// What --init-env writes: the filled template plus the addable keys .env.example only comments out.
const generatedText = () => {
  const values = generateEnvValues();
  const addable = Object.fromEntries(ADDABLE_SECRETS.map((key) => [key, values[key]]));
  return appendMissingEnvValues(Buffer.from(fillEnvTemplate(EXAMPLE, values), 'utf8'), addable).bytes.toString('utf8');
};
const generatedFile = () => parseEnvText(generatedText());
const SECRET_KEYS = ['POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY', 'OTP_HASH_SECRET', 'ADMIN_MFA_ENCRYPTION_KEY'];
const noValueIn = (problems, env) => {
  for (const key of SECRET_KEYS) {
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

test('the optional Resend sender: unset, complete, or rejected as half-configured, without echoing values (Work 62)', () => {
  const base = generatedFile();
  assert.deepEqual(emailProviderState(base), { configured: false, problem: null });
  assert.deepEqual(validateEnvValues(base).problems, []);

  const complete = { ...base, RESEND_API_KEY: 're_test_0123456789abcdef', RESEND_FROM_EMAIL: 'PharmaLink <otp@demo.example>' };
  assert.deepEqual(emailProviderState(complete), { configured: true, problem: null });
  assert.deepEqual(validateEnvValues(complete).problems, []);

  for (const [override, expected] of [
    [{ RESEND_API_KEY: 're_test_0123456789abcdef' }, /set together/],
    [{ RESEND_FROM_EMAIL: 'otp@demo.example' }, /set together/],
    [{ RESEND_API_KEY: 'REPLACE_ME', RESEND_FROM_EMAIL: 'otp@demo.example' }, /placeholder/],
    [{ RESEND_API_KEY: 're_test_0123456789abcdef', RESEND_FROM_EMAIL: 'PharmaLink' }, /sender address/],
  ]) {
    const env = { ...base, ...override };
    const { problems } = validateEnvValues(env);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], expected);
    assert.ok(!problems[0].includes('re_test_0123456789abcdef'));
    assert.equal(emailProviderState(env).configured, false);
  }
});

// --- ADMIN_MFA_ENCRYPTION_KEY (Work 68) ----------------------------------------------------------

const validKey = () => generateAdminMfaKey();

test('generation: ADMIN_MFA_ENCRYPTION_KEY is standard base64 of 32 bytes, dedicated, fresh each run', () => {
  const values = generateEnvValues();
  assert.match(values.ADMIN_MFA_ENCRYPTION_KEY, /^[A-Za-z0-9+/]{43}=$/);
  assert.equal(Buffer.from(values.ADMIN_MFA_ENCRYPTION_KEY, 'base64').length, 32);
  assert.equal(new Set(SECRET_KEYS.map((k) => values[k])).size, SECRET_KEYS.length);
  const seen = new Set(Array.from({ length: 20 }, () => generateEnvValues().ADMIN_MFA_ENCRYPTION_KEY));
  assert.equal(seen.size, 20);
});

test('generation uses 32 CSPRNG bytes as standard base64 and retries an unusable candidate', () => {
  const good = Buffer.from(Array.from({ length: 32 }, (_, i) => i * 7 + 1));
  const requested = [];
  const candidates = [Buffer.alloc(32, 0), good];
  const key = generateAdminMfaKey([], (n) => (requested.push(n), candidates.shift()));
  assert.equal(key, good.toString('base64'));
  assert.deepEqual(requested, [32, 32]);
  assert.throws(() => generateAdminMfaKey([], () => Buffer.alloc(32, 0)), /could not generate/);
  assert.throws(() => generateAdminMfaKey([good.toString('base64')], () => good), /could not generate/);
});

test('the generated env file (--init-env) contains one valid ADMIN_MFA_ENCRYPTION_KEY and keeps the documentation', () => {
  const text = generatedText();
  const env = parseEnvText(text);
  assert.equal(adminMfaKeyProblem(env.ADMIN_MFA_ENCRYPTION_KEY, [env.JWT_ACCESS_SECRET, env.MASTER_ENCRYPTION_KEY]), null);
  assert.deepEqual(validateEnvValues(env).problems, []);
  assert.equal(text.match(/^ADMIN_MFA_ENCRYPTION_KEY=/gm).length, 1);
  assert.ok(text.includes('# ADMIN_MFA_ENCRYPTION_KEY='), 'the commented documentation line is kept');
});

test('ADMIN_MFA_ENCRYPTION_KEY rules match decodeAdminMfaKey (Work 66)', () => {
  const key = validKey();
  assert.equal(adminMfaKeyProblem(key), null);
  assert.equal(adminMfaKeyProblem(`  ${key}  `), null);
  assert.match(adminMfaKeyProblem(undefined), /missing/);
  assert.match(adminMfaKeyProblem('   '), /missing/);
  assert.match(adminMfaKeyProblem('not-a-key'), /standard base64 of exactly 32 bytes/);
  assert.match(adminMfaKeyProblem(Buffer.alloc(32, 9).toString('base64url')), /standard base64/, 'base64url without padding');
  assert.match(adminMfaKeyProblem(key.replace('=', '')), /standard base64/, 'unpadded');
  assert.match(adminMfaKeyProblem(`-${key.slice(1)}`), /standard base64/, 'base64url alphabet');
  assert.match(adminMfaKeyProblem(Buffer.from('0123456789abcdef').toString('base64')), /standard base64/, '16 bytes');
  assert.match(adminMfaKeyProblem(Buffer.alloc(48, 1).toString('base64')), /standard base64/, '48 bytes');
  assert.match(adminMfaKeyProblem(Buffer.alloc(32, 0).toString('base64')), /placeholder/);
  assert.match(adminMfaKeyProblem(key, ['x', key]), /dedicated secret/);
});

test('validation requires a valid, dedicated ADMIN_MFA_ENCRYPTION_KEY without echoing any value', () => {
  const base = generatedFile();
  const cases = [
    [{ ADMIN_MFA_ENCRYPTION_KEY: undefined }, /ADMIN_MFA_ENCRYPTION_KEY is missing or still a placeholder \(add it with: node ops\/staging\/ensure-env-secrets\.mjs\)/],
    [{ ADMIN_MFA_ENCRYPTION_KEY: '' }, /ADMIN_MFA_ENCRYPTION_KEY is missing or still a placeholder$/],
    [{ ADMIN_MFA_ENCRYPTION_KEY: 'REPLACE_ME' }, /ADMIN_MFA_ENCRYPTION_KEY is missing or still a placeholder$/],
    [{ ADMIN_MFA_ENCRYPTION_KEY: 'c2hvcnQta2V5LXRoYXQtaXMtbm90LTMyLWJ5dGVz' }, /standard base64 of exactly 32 bytes/],
    [{ ADMIN_MFA_ENCRYPTION_KEY: Buffer.alloc(32, 0).toString('base64') }, /placeholder/],
    [{ ADMIN_MFA_ENCRYPTION_KEY: base.MASTER_ENCRYPTION_KEY }, /dedicated secret/],
  ];
  for (const [override, expected] of cases) {
    const env = { ...base, ...override };
    if (override.ADMIN_MFA_ENCRYPTION_KEY === undefined) delete env.ADMIN_MFA_ENCRYPTION_KEY;
    const { problems } = validateEnvValues(env);
    assert.equal(problems.length, 1, JSON.stringify(problems));
    assert.match(problems[0], expected);
    noValueIn(problems, env);
    if (override.ADMIN_MFA_ENCRYPTION_KEY) assert.ok(!problems[0].includes(override.ADMIN_MFA_ENCRYPTION_KEY));
  }
  // A copy of JWT_ACCESS_SECRET, JWT_REFRESH_SECRET or OTP_HASH_SECRET is refused the same way.
  for (const other of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'OTP_HASH_SECRET']) {
    const key = validKey();
    const { problems } = validateEnvValues({ ...base, [other]: key, ADMIN_MFA_ENCRYPTION_KEY: key });
    assert.ok(problems.some((p) => /ADMIN_MFA_ENCRYPTION_KEY must be a dedicated secret/.test(p)), `${other}: ${JSON.stringify(problems)}`);
    assert.ok(!problems.join('\n').includes(key));
  }
});

// --- appendMissingEnvValues: additive, byte-preserving, idempotent -------------------------------

const EXISTING = 'POSTGRES_PASSWORD=abc\n# a comment, kept\nJWT_ACCESS_SECRET="quoted value"\n\nBACKEND_HOST_PORT=3000\n';

test('a missing key is appended; every existing byte is kept as a prefix, with the file\'s line ending', () => {
  const key = validKey();
  for (const original of [EXISTING, EXISTING.replace(/\n/g, '\r\n'), EXISTING.trimEnd(), EXISTING.replace(/\n/g, '\r\n').trimEnd(), '', '﻿A=1\n']) {
    const before = Buffer.from(original, 'utf8');
    const { bytes, added } = appendMissingEnvValues(before, { ADMIN_MFA_ENCRYPTION_KEY: key });
    assert.deepEqual(added, ['ADMIN_MFA_ENCRYPTION_KEY']);
    assert.ok(bytes.subarray(0, before.length).equals(before), `prefix changed for ${JSON.stringify(original)}`);
    const text = bytes.toString('utf8');
    assert.equal(parseEnvText(text).ADMIN_MFA_ENCRYPTION_KEY, key);
    const appended = text.slice(original.length);
    if (original.includes('\r\n')) assert.ok(!/(^|[^\r])\n/.test(appended), 'a CRLF file gets CRLF lines');
    else assert.ok(!appended.includes('\r'), 'an LF file gets LF lines');
  }
});

test('a present key is never replaced or rotated, whatever its value', () => {
  for (const line of [`ADMIN_MFA_ENCRYPTION_KEY=${validKey()}`, 'ADMIN_MFA_ENCRYPTION_KEY=broken', 'ADMIN_MFA_ENCRYPTION_KEY=', '  ADMIN_MFA_ENCRYPTION_KEY = spaced']) {
    const before = Buffer.from(`${EXISTING}${line}\n`, 'utf8');
    const { bytes, added } = appendMissingEnvValues(before, { ADMIN_MFA_ENCRYPTION_KEY: validKey() });
    assert.deepEqual(added, []);
    assert.equal(bytes, before, 'the same buffer is returned untouched');
  }
});

test('a commented-out key counts as missing; a second run adds nothing (idempotent)', () => {
  const before = Buffer.from(`${EXISTING}# ADMIN_MFA_ENCRYPTION_KEY=\n`, 'utf8');
  const first = appendMissingEnvValues(before, { ADMIN_MFA_ENCRYPTION_KEY: validKey() });
  assert.deepEqual(first.added, ['ADMIN_MFA_ENCRYPTION_KEY']);
  const second = appendMissingEnvValues(first.bytes, { ADMIN_MFA_ENCRYPTION_KEY: validKey() });
  assert.deepEqual(second.added, []);
  assert.ok(second.bytes.equals(first.bytes));
});

// --- ensure-env-secrets.mjs, end to end on temporary files ---------------------------------------

const SCRIPT = join(HERE, 'ensure-env-secrets.mjs');

function withTempEnv(content, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pharmalink-env-test-'));
  const file = join(dir, '.env.staging');
  try {
    if (content !== null) writeFileSync(file, content);
    return fn(file, dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const runScript = (file, ...extra) => {
  const res = spawnSync(process.execPath, [SCRIPT, `--target=${file}`, ...extra], { encoding: 'utf8' });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
};

/** A staging file written before Work 68: valid then, but without ADMIN_MFA_ENCRYPTION_KEY. */
const preWork68File = (eol = '\n') => fillEnvTemplate(EXAMPLE, generateEnvValues()).replace(/\r?\n/g, eol);

const assertNoSecretIn = (out, text) => {
  const env = parseEnvText(text);
  for (const key of [...SECRET_KEYS, 'RESEND_API_KEY']) {
    if (env[key] && env[key].length >= 8) assert.ok(!out.includes(env[key]), `output contains the value of ${key}`);
  }
};

test('CLI: adds a missing key once, keeps every existing byte, prints no value, and is idempotent', () => {
  for (const eol of ['\n', '\r\n']) {
    const original = Buffer.from(preWork68File(eol), 'utf8');
    withTempEnv(original, (file, dir) => {
      const first = runScript(file);
      assert.equal(first.status, 0, first.out);
      const afterFirst = readFileSync(file);
      assert.ok(afterFirst.subarray(0, original.length).equals(original), 'existing bytes changed');
      const env = parseEnvText(afterFirst.toString('utf8'));
      assert.equal(adminMfaKeyProblem(env.ADMIN_MFA_ENCRYPTION_KEY, [env.JWT_ACCESS_SECRET, env.JWT_REFRESH_SECRET, env.MASTER_ENCRYPTION_KEY, env.OTP_HASH_SECRET]), null);
      assert.match(first.out, /ADMIN_MFA_ENCRYPTION_KEY: added \(dedicated random value, not shown\)/);
      assert.match(first.out, /ADMIN_MFA_ENCRYPTION_KEY valid \(base64 of 32 bytes, dedicated\): PASS/);
      assert.match(first.out, /e-mail provider \(RESEND_API_KEY, RESEND_FROM_EMAIL\): not configured/);
      assert.match(first.out, /env file: PASS/);
      assertNoSecretIn(first.out, afterFirst.toString('utf8'));

      const second = runScript(file);
      assert.equal(second.status, 0, second.out);
      assert.ok(readFileSync(file).equals(afterFirst), 'the second run changed the file');
      assert.match(second.out, /present, left unchanged \(never rotated automatically\)/);
      assertNoSecretIn(second.out, afterFirst.toString('utf8'));
      assert.deepEqual(readdirSync(dir), ['.env.staging'], 'a temporary file was left behind');
    });
  }
});

test('CLI: --check writes nothing and fails while the key is missing', () => {
  const original = Buffer.from(preWork68File(), 'utf8');
  withTempEnv(original, (file) => {
    const res = runScript(file, '--check');
    assert.equal(res.status, 1);
    assert.ok(readFileSync(file).equals(original));
    assert.match(res.out, /ADMIN_MFA_ENCRYPTION_KEY: missing \(--check: nothing written\)/);
    assert.match(res.out, /ADMIN_MFA_ENCRYPTION_KEY valid .*: FAIL/);
    assertNoSecretIn(res.out, original.toString('utf8'));
  });
});

test('CLI: an invalid present key is reported, never replaced, and its value is not printed', () => {
  const invalid = 'aW52YWxpZC1rZXktdGhhdC1pcy1sb25nLWVub3VnaA';
  const original = Buffer.from(`${preWork68File()}ADMIN_MFA_ENCRYPTION_KEY=${invalid}\n`, 'utf8');
  withTempEnv(original, (file) => {
    const res = runScript(file);
    assert.equal(res.status, 1);
    assert.ok(readFileSync(file).equals(original), 'the invalid key was changed');
    assert.match(res.out, /ADMIN_MFA_ENCRYPTION_KEY valid .*: FAIL \(ADMIN_MFA_ENCRYPTION_KEY must be standard base64/);
    assert.ok(!res.out.includes(invalid));
    assertNoSecretIn(res.out, original.toString('utf8'));
  });
});

test('CLI: reports Resend as configured without printing it, and refuses a missing file', () => {
  const resend = 'RESEND_API_KEY=re_test_secret_0123456789\nRESEND_FROM_EMAIL=PharmaLink <otp@demo.example>\n';
  withTempEnv(`${preWork68File()}${resend}`, (file) => {
    const res = runScript(file);
    assert.equal(res.status, 0, res.out);
    assert.match(res.out, /e-mail provider .*: configured/);
    assert.ok(!res.out.includes('re_test_secret_0123456789'));
    assert.ok(!res.out.includes('otp@demo.example'));
  });
  withTempEnv(null, (file) => {
    const res = runScript(file);
    assert.equal(res.status, 1);
    assert.match(res.out, /FAIL: missing .*--init-env/);
  });
});

// --- Compose wiring ------------------------------------------------------------------------------

test('compose.staging.yml gives backend and tools the env file and never overrides ADMIN_MFA_ENCRYPTION_KEY', () => {
  const compose = readFileSync(join(HERE, '..', '..', 'compose.staging.yml'), 'utf8').replace(/\r\n/g, '\n');
  const service = (name) => {
    const start = compose.search(new RegExp(`^  ${name}:[ \\t]*$`, 'm'));
    assert.ok(start >= 0, `service ${name} not found`);
    const rest = compose.slice(start).split('\n').slice(1);
    const end = rest.findIndex((l) => /^ {0,2}\S/.test(l) && !/^\s*#/.test(l));
    return (end < 0 ? rest : rest.slice(0, end)).join('\n');
  };
  for (const name of ['backend', 'tools']) {
    const block = service(name);
    assert.match(block, /env_file:\n\s*- path: \.\/backend\/\.env\.staging\n\s*required: true/, `${name} does not load backend/.env.staging`);
    assert.ok(!block.includes('ADMIN_MFA_ENCRYPTION_KEY'), `${name} overrides ADMIN_MFA_ENCRYPTION_KEY`);
  }
});
