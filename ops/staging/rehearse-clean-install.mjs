#!/usr/bin/env node
// PharmaLink — clean-install rehearsal on a brand-new, disposable LOCAL Docker Compose stack.
// See ops/staging/README.md. Not a deployment; never touches any database outside this stack.
//
//   node ops/staging/rehearse-clean-install.mjs --init-env   # create backend/.env.staging with random local secrets
//   node ops/staging/rehearse-clean-install.mjs              # run the rehearsal, then remove everything it created
//   node ops/staging/rehearse-clean-install.mjs --keep       # run it and leave the stack running for inspection
//
// Requires Node.js 22+ and Docker with Compose v2.24+.

import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = join(ROOT, 'compose.staging.yml');
const ENV_FILE = join(ROOT, 'backend', '.env.staging');
// Dedicated project name: every container, network, volume and image this script creates or
// removes belongs to this Compose project and nothing else.
const PROJECT = 'pharmalink-staging-rehearsal';
const EXPECTED_ROLES = 14;

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');

// Child processes get a sanitised environment: a DATABASE_URL, REDIS_URL or Compose override in
// the caller's shell can never leak into the stack or redirect it.
const childEnv = { ...process.env };
for (const k of ['DATABASE_URL', 'REDIS_URL', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD']) {
  delete childEnv[k];
}

let currentStep = 'startup';
let stackCreated = false;

function log(msg) {
  console.log(msg);
}

function step(name) {
  currentStep = name;
  log(`\n=== ${name}`);
}

function run(cmd, cmdArgs, { capture = false, allowFail = false } = {}) {
  const res = spawnSync(cmd, cmdArgs, {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });
  if (res.error) throw new Error(`could not run ${cmd}: ${res.error.message}`);
  if (res.status !== 0 && !allowFail) {
    const out = capture ? `\n${res.stdout ?? ''}${res.stderr ?? ''}` : '';
    throw new Error(`${cmd} ${cmdArgs.join(' ')} exited with ${res.status}${out}`);
  }
  return res;
}

const compose = (composeArgs, opts) =>
  run('docker', ['compose', '-p', PROJECT, '-f', COMPOSE_FILE, '--env-file', ENV_FILE, ...composeArgs], opts);

function parseEnvFile(path) {
  const env = {};
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
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

function initEnv() {
  if (existsSync(ENV_FILE)) {
    console.error(`${ENV_FILE} already exists; not overwriting it. Delete it first to regenerate.`);
    process.exit(1);
  }
  const example = readFileSync(join(ROOT, 'backend', '.env.example'), 'utf8');
  const values = {
    POSTGRES_PASSWORD: randomBytes(24).toString('hex'),
    JWT_ACCESS_SECRET: randomBytes(32).toString('hex'),
    JWT_REFRESH_SECRET: randomBytes(32).toString('hex'),
    MASTER_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  };
  const filled = example.replace(/^([A-Z_]+)=REPLACE_ME$/gm, (m, key) => (values[key] ? `${key}=${values[key]}` : m));
  writeFileSync(ENV_FILE, filled, { encoding: 'utf8', flag: 'wx' });
  log(`Created ${ENV_FILE} with random local-only secrets (gitignored). Values were not printed.`);
}

function checkEnv() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`missing ${ENV_FILE}. Create it with: node ops/staging/rehearse-clean-install.mjs --init-env (or copy backend/.env.example and fill it in).`);
  }
  const env = parseEnvFile(ENV_FILE);
  const problems = [];
  for (const key of ['POSTGRES_PASSWORD', 'JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET', 'MASTER_ENCRYPTION_KEY']) {
    if (!env[key] || env[key].includes('REPLACE_ME')) problems.push(`${key} is missing or still a placeholder`);
  }
  if (env.POSTGRES_PASSWORD && !/^[A-Za-z0-9]{16,}$/.test(env.POSTGRES_PASSWORD)) problems.push('POSTGRES_PASSWORD must be at least 16 letters/digits');
  for (const key of ['JWT_ACCESS_SECRET', 'JWT_REFRESH_SECRET']) {
    if (env[key] && env[key].length < 16) problems.push(`${key} must be at least 16 characters`);
  }
  if (env.JWT_ACCESS_SECRET && env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) problems.push('JWT_ACCESS_SECRET and JWT_REFRESH_SECRET must differ');
  if (env.MASTER_ENCRYPTION_KEY && Buffer.from(env.MASTER_ENCRYPTION_KEY, 'base64').length !== 32) problems.push('MASTER_ENCRYPTION_KEY must be base64 of exactly 32 bytes');
  // The stack sets these itself; a value in the file would be overridden, so reject it to avoid
  // anyone believing the rehearsal ran against the database it names.
  for (const key of ['DATABASE_URL', 'REDIS_URL', 'NODE_ENV']) {
    if (key in env) problems.push(`${key} must not be set in ${ENV_FILE}; compose.staging.yml sets it to the disposable stack`);
  }
  // Known issue: env.validation.ts rejects PORT given as an environment string; the container
  // listens on the default 3000 (use BACKEND_HOST_PORT to change the host side).
  if ('PORT' in env) problems.push(`PORT must not be set in ${ENV_FILE} (known issue, see ops/staging/README.md); use BACKEND_HOST_PORT for the host port`);
  if (problems.length) throw new Error(`invalid ${ENV_FILE}:\n  - ${problems.join('\n  - ')}`);
  const port = Number(env.BACKEND_HOST_PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('BACKEND_HOST_PORT must be a port number');
  return { port };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitHealthy(service, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const id = compose(['ps', '-q', service], { capture: true }).stdout.trim();
    if (id) {
      const state = run('docker', ['inspect', '-f', '{{.State.Health.Status}}', id], { capture: true, allowFail: true }).stdout.trim();
      if (state === 'healthy') return;
      if (state === 'unhealthy') throw new Error(`${service} reported unhealthy`);
    }
    if (Date.now() > deadline) throw new Error(`${service} did not become healthy within ${timeoutMs / 1000}s`);
    await sleep(2000);
  }
}

async function httpCheck(url, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let res;
    try {
      res = await fetch(url);
    } catch (err) {
      if (Date.now() > deadline) throw new Error(`${url} unreachable: ${err.message}`);
      await sleep(2000);
      continue;
    }
    const body = await res.text();
    if (res.ok) return `${res.status} ${body.slice(0, 200)}`;
    if (res.status === 401) {
      throw new Error(`${url} -> HTTP 401 ${body.slice(0, 200)}
` +
        'The health endpoints require authentication: they are not marked @Public(), so the global JwtAuthGuard rejects ' +
        'unauthenticated probes. This is an application defect (see ops/staging/README.md, "Known issues"), not a packaging fault.');
    }
    if (Date.now() > deadline) throw new Error(`${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
    await sleep(2000);
  }
}

function psql(sql) {
  return compose(['exec', '-T', 'postgres', 'psql', '-U', 'pharmalink', '-d', 'pharmalink_staging', '-XAtc', sql], { capture: true }).stdout.trim();
}

function cleanup(reason) {
  log(`\n=== cleanup (${reason}): removing project "${PROJECT}" only — its containers, network, volume and built images`);
  compose(['--profile', 'tools', 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], { allowFail: true });
}

async function main() {
  if (args.has('--init-env')) return initEnv();

  step('1. prerequisites and local environment');
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) throw new Error(`Node.js 22+ required (found ${process.versions.node})`);
  run('docker', ['version', '--format', 'Docker server {{.Server.Version}}']);
  run('docker', ['compose', 'version']);
  const { port } = checkEnv();
  log(`env file OK (${ENV_FILE}); backend will be published on 127.0.0.1:${port}`);
  compose(['--profile', 'tools', 'config', '--quiet']);
  log('compose configuration is valid');

  step(`2. ensure a brand-new stack (scoped cleanup of project "${PROJECT}" only)`);
  compose(['--profile', 'tools', 'down', '--volumes', '--remove-orphans'], { allowFail: true });
  stackCreated = true;

  step('3. start PostgreSQL 16 and Redis 7, wait for readiness');
  compose(['up', '-d', 'postgres', 'redis']);
  await waitHealthy('postgres', 120_000);
  await waitHealthy('redis', 60_000);
  const tables = psql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public'");
  log(`postgres and redis healthy; public tables before install: ${tables}`);
  if (tables !== '0') throw new Error(`database is not empty (${tables} tables); refusing to treat it as a clean install`);

  step('4. build backend images (runtime and tools targets)');
  compose(['--profile', 'tools', 'build', 'backend', 'tools']);

  step('5. prisma migrate deploy (first run)');
  compose(['run', '--rm', 'tools', 'npx', 'prisma', 'migrate', 'deploy']);
  const migrations = psql('SELECT count(*) FILTER (WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL) || \'/\' || count(*) FROM "_prisma_migrations"');
  log(`applied migrations (finished/total): ${migrations}`);

  step('6. seed roles and permissions (first run)');
  compose(['run', '--rm', 'tools', 'npm', 'run', 'prisma:seed']);
  const counts1 = psql('SELECT (SELECT count(*) FROM roles) || \' roles, \' || (SELECT count(*) FROM permissions) || \' permissions, \' || (SELECT count(*) FROM role_permissions) || \' grants\'');
  log(`after first seed: ${counts1}`);

  step('7. seed again (repeatability)');
  compose(['run', '--rm', 'tools', 'npm', 'run', 'prisma:seed']);
  const counts2 = psql('SELECT (SELECT count(*) FROM roles) || \' roles, \' || (SELECT count(*) FROM permissions) || \' permissions, \' || (SELECT count(*) FROM role_permissions) || \' grants\'');
  log(`after second seed: ${counts2}`);
  if (counts1 !== counts2) throw new Error(`seed is not repeatable: "${counts1}" then "${counts2}"`);
  if (!counts2.startsWith(`${EXPECTED_ROLES} roles`)) throw new Error(`expected ${EXPECTED_ROLES} roles, got "${counts2}"`);

  step('8. start the backend and check health');
  compose(['up', '-d', 'backend']);
  log(`GET /health/live  -> ${await httpCheck(`http://127.0.0.1:${port}/health/live`)}`);
  log(`GET /health/ready -> ${await httpCheck(`http://127.0.0.1:${port}/health/ready`)}`);
  await waitHealthy('backend', 180_000);
  log('backend container health check: healthy');

  step('9. prisma migrate deploy again (must find nothing pending)');
  const again = compose(['run', '--rm', 'tools', 'npx', 'prisma', 'migrate', 'deploy'], { capture: true });
  const output = `${again.stdout}${again.stderr}`;
  process.stdout.write(output);
  if (!/No pending migrations to apply/i.test(output)) throw new Error('second migrate deploy did not report "No pending migrations to apply"');

  log('\n=== REHEARSAL PASSED');
}

try {
  await main();
  if (stackCreated) {
    if (KEEP) log(`\n--keep: stack left running. Remove it later with:\n  docker compose -p ${PROJECT} -f compose.staging.yml --env-file backend/.env.staging --profile tools down --volumes --remove-orphans --rmi local`);
    else cleanup('success');
  }
} catch (err) {
  console.error(`\n=== REHEARSAL FAILED at step: ${currentStep}\n${err.message}`);
  if (stackCreated) {
    compose(['logs', '--no-color', '--tail', '80', 'backend'], { allowFail: true });
    if (KEEP) log(`\n--keep: stack left in place for debugging (project "${PROJECT}").`);
    else cleanup('failure');
  }
  process.exitCode = 1;
}
