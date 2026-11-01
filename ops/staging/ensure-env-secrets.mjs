#!/usr/bin/env node
// PharmaLink — add missing staging-only secrets to an EXISTING backend/.env.staging (Work 68).
// See ops/staging/README.md, "Adding ADMIN_MFA_ENCRYPTION_KEY to an existing env file".
//
//   node ops/staging/ensure-env-secrets.mjs           # add ADMIN_MFA_ENCRYPTION_KEY if missing, then validate
//   node ops/staging/ensure-env-secrets.mjs --check   # validate only, write nothing
//   --target=<path>                                    # another file (the tests use temporary copies; not --env-file,
//                                                      # which Node itself would load)
//
// Guarantees:
// - only keys in ADDABLE_SECRETS that have no active line are added; a present key (valid or not)
//   is never replaced, so an existing key is never rotated;
// - every existing byte of the file is kept: the new file starts with the old one, byte for byte,
//   which is verified before the new file replaces the old one (atomic rename in the same directory);
// - running it again changes nothing;
// - no value is ever printed: output names keys and states (PASS/FAIL, configured/not configured).

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ADDABLE_SECRETS,
  adminMfaKeyProblem,
  adminMfaOtherSecrets,
  appendMissingEnvValues,
  assignedKeys,
  emailProviderState,
  generateAdminMfaKey,
  parseEnvText,
  validateEnvValues,
} from './env-file.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ARGS = process.argv.slice(2);
const CHECK_ONLY = ARGS.includes('--check');
const ENV_FILE_ARG = ARGS.find((a) => a.startsWith('--target='));
const ENV_FILE = ENV_FILE_ARG ? resolve(ENV_FILE_ARG.slice('--target='.length)) : join(ROOT, 'backend', '.env.staging');

const log = (msg) => console.log(msg);

function fail(msg) {
  throw new Error(msg);
}

/** Fresh values for the addable keys that are missing, each checked against the file's other secrets. */
function valuesFor(missing, env) {
  const values = {};
  for (const key of missing) {
    if (key === 'ADMIN_MFA_ENCRYPTION_KEY') values[key] = generateAdminMfaKey(adminMfaOtherSecrets(env), randomBytes);
  }
  return values;
}

function addMissing(original) {
  const env = parseEnvText(original.toString('utf8'));
  const present = assignedKeys(original.toString('utf8'));
  const missing = ADDABLE_SECRETS.filter((key) => !present.has(key));
  for (const key of ADDABLE_SECRETS.filter((k) => present.has(k))) log(`${key}: present, left unchanged (never rotated automatically)`);
  if (!missing.length) return;
  if (CHECK_ONLY) {
    for (const key of missing) log(`${key}: missing (--check: nothing written)`);
    return;
  }

  const { bytes, added } = appendMissingEnvValues(original, valuesFor(missing, env));
  if (!bytes.subarray(0, original.length).equals(original)) fail('internal error: existing content would change; nothing written');
  const next = parseEnvText(bytes.toString('utf8'));
  for (const key of added) {
    const problem = key === 'ADMIN_MFA_ENCRYPTION_KEY' ? adminMfaKeyProblem(next[key], adminMfaOtherSecrets(next)) : null;
    if (problem) fail(`generated ${key} would be invalid (${problem}); nothing written`);
  }

  // Temporary file beside the target, created exclusively and readable by the owner only, then
  // renamed over it. The file is re-read first so a concurrent edit is never lost.
  const temp = join(dirname(ENV_FILE), `.${basename(ENV_FILE)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode: 0o600 });
    if (!readFileSync(temp).equals(bytes)) fail('temporary file did not read back identically; nothing replaced');
    if (!readFileSync(ENV_FILE).equals(original)) fail(`${ENV_FILE} changed while this ran; nothing replaced, run again`);
    renameSync(temp, ENV_FILE);
  } finally {
    if (existsSync(temp)) rmSync(temp, { force: true });
  }
  const written = readFileSync(ENV_FILE);
  if (!written.subarray(0, original.length).equals(original)) fail(`${ENV_FILE} does not start with its previous content; restore it from your backup`);
  for (const key of added) log(`${key}: added (dedicated random value, not shown)`);
}

function main() {
  if (!existsSync(ENV_FILE)) {
    fail(`missing ${ENV_FILE}. Create a new one with: node ops/staging/rehearse-clean-install.mjs --init-env`);
  }
  addMissing(readFileSync(ENV_FILE));
  report();
}

function report() {
  const env = parseEnvText(readFileSync(ENV_FILE, 'utf8'));
  const mfaProblem = adminMfaKeyProblem(env.ADMIN_MFA_ENCRYPTION_KEY, adminMfaOtherSecrets(env));
  log(`ADMIN_MFA_ENCRYPTION_KEY valid (base64 of 32 bytes, dedicated): ${mfaProblem ? `FAIL (${mfaProblem})` : 'PASS'}`);
  const email = emailProviderState(env);
  log(`e-mail provider (RESEND_API_KEY, RESEND_FROM_EMAIL): ${email.configured ? 'configured' : `not configured${email.problem ? ` (${email.problem})` : ''}`}`);
  const { problems } = validateEnvValues(env, ENV_FILE);
  if (problems.length) {
    log(`env file: FAIL\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
  } else {
    log('env file: PASS (values not shown)');
  }
}

try {
  main();
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exitCode = 1;
}
