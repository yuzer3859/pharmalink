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
import { fillEnvTemplate, generateEnvValues, parseEnvText, validateEnvValues } from './env-file.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const COMPOSE_FILE = join(ROOT, 'compose.staging.yml');
const ENV_FILE = join(ROOT, 'backend', '.env.staging');
// Dedicated project name: every container, network, volume and image this script creates or
// removes belongs to this Compose project and nothing else.
const PROJECT = 'pharmalink-staging-rehearsal';
const PROJECT_LABEL = `label=com.docker.compose.project=${PROJECT}`;
const EXPECTED_ROLES = 14;
const REDIS_OTP_LOG = 'OTP challenges are stored in Redis (OTP_STORE=redis).';
const MEMORY_OTP_LOG = 'OTP challenges are kept in memory';

const args = new Set(process.argv.slice(2));
const KEEP = args.has('--keep');

// Child processes get a sanitised environment: a DATABASE_URL, REDIS_URL, Compose override or
// interpolated value in the caller's shell can never leak into the stack, redirect it, or replace
// a value from the env file (for Compose interpolation the shell would win over --env-file).
const childEnv = { ...process.env };
for (const k of ['DATABASE_URL', 'REDIS_URL', 'COMPOSE_PROJECT_NAME', 'COMPOSE_FILE', 'COMPOSE_PROFILES', 'POSTGRES_PASSWORD', 'OTP_STORE', 'OTP_HASH_SECRET', 'BACKEND_HOST_PORT']) {
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
    maxBuffer: 64 * 1024 * 1024,
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

const lines = (text) => text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

function initEnv() {
  if (existsSync(ENV_FILE)) {
    console.error(`${ENV_FILE} already exists; not overwriting it. Delete it first to regenerate.`);
    process.exit(1);
  }
  const filled = fillEnvTemplate(readFileSync(join(ROOT, 'backend', '.env.example'), 'utf8'), generateEnvValues(randomBytes));
  const { problems } = validateEnvValues(parseEnvText(filled), ENV_FILE);
  if (problems.length) throw new Error(`generated env file would be invalid (nothing written):\n  - ${problems.join('\n  - ')}`);
  writeFileSync(ENV_FILE, filled, { encoding: 'utf8', flag: 'wx' });
  log(`Created ${ENV_FILE} with random local-only secrets, including a dedicated OTP_HASH_SECRET (gitignored). Values were not printed.`);
}

function checkEnv() {
  if (!existsSync(ENV_FILE)) {
    throw new Error(`missing ${ENV_FILE}. Create it with: node ops/staging/rehearse-clean-install.mjs --init-env (or copy backend/.env.example and fill it in).`);
  }
  const { problems, port } = validateEnvValues(parseEnvText(readFileSync(ENV_FILE, 'utf8')), ENV_FILE);
  if (problems.length) throw new Error(`invalid ${ENV_FILE}:\n  - ${problems.join('\n  - ')}`);
  return { port };
}

/** What already exists under this project's name, by Compose label. */
function projectResources() {
  return {
    containers: lines(run('docker', ['ps', '-a', '--filter', PROJECT_LABEL, '--format', '{{.Names}}'], { capture: true }).stdout),
    volumes: lines(run('docker', ['volume', 'ls', '-q', '--filter', PROJECT_LABEL], { capture: true }).stdout),
    networks: lines(run('docker', ['network', 'ls', '-q', '--filter', PROJECT_LABEL], { capture: true }).stdout),
    images: lines(run('docker', ['image', 'ls', '-q', '--filter', `reference=${PROJECT}-*`], { capture: true }).stdout),
  };
}

const describe = (r) => `${r.containers.length} container(s), ${r.volumes.length} volume(s), ${r.networks.length} network(s), ${r.images.length} image(s)`;

const samePath = (a, b) => resolve(a).replace(/\\/g, '/').toLowerCase() === resolve(b).replace(/\\/g, '/').toLowerCase();

/**
 * Leftovers of this project are ours to remove only if they came from this compose file. A
 * container of the same project name created from any other file (another checkout, another tool)
 * makes ownership unclear: stop and report, delete nothing.
 */
function assertOwnership(existing) {
  for (const name of existing.containers) {
    const files = run('docker', ['inspect', '-f', '{{index .Config.Labels "com.docker.compose.project.config_files"}}', name], { capture: true }).stdout.trim();
    if (!files.split(',').some((f) => f && samePath(f, COMPOSE_FILE))) {
      throw new Error(`container ${name} belongs to project "${PROJECT}" but was not created from ${COMPOSE_FILE}; ownership is unclear, so nothing was removed. Inspect it and remove it yourself if it is a leftover.`);
    }
  }
}

/** Running containers outside this project, to confirm afterwards that they were left alone. */
function unrelatedRunning() {
  return lines(run('docker', ['ps', '--format', '{{.ID}} {{.Names}} {{.Label "com.docker.compose.project"}}'], { capture: true }).stdout)
    .map((l) => l.split(' '))
    .filter(([, , project]) => project !== PROJECT)
    .map(([id, name]) => ({ id, name }));
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
      res = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
        'The health endpoints must be public (fixed in #8); a 401 means the image predates that fix or the route lost @Public().');
    }
    if (Date.now() > deadline) throw new Error(`${url} -> HTTP ${res.status}: ${body.slice(0, 300)}`);
    await sleep(2000);
  }
}

/** POSTs JSON and returns the status and the response's error code only; the body is not printed. */
async function post(url, payload) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10_000),
  });
  let errorCode;
  try {
    errorCode = (await res.json())?.error?.code;
  } catch {
    errorCode = undefined;
  }
  return { status: res.status, errorCode };
}

function psql(sql) {
  return compose(['exec', '-T', 'postgres', 'psql', '-U', 'pharmalink', '-d', 'pharmalink_staging', '-XAtc', sql], { capture: true }).stdout.trim();
}

/** Number of OTP keys in the stack's Redis. Counted inside the container; key names never leave it. */
function otpKeyCount() {
  const out = compose(['exec', '-T', 'redis', 'sh', '-c', "redis-cli --scan --pattern '*otp:v1:*' | wc -l"], { capture: true }).stdout.trim();
  const n = Number(out);
  if (!Number.isInteger(n)) throw new Error('could not count OTP keys in the stack Redis');
  return n;
}

function cleanup(reason) {
  log(`\n=== cleanup (${reason}): removing project "${PROJECT}" only — its containers, network, volume and built images`);
  compose(['--profile', 'tools', 'down', '--volumes', '--remove-orphans', '--rmi', 'local'], { allowFail: true });
}

function verifyCleanup(before) {
  const left = projectResources();
  log(`project "${PROJECT}" after cleanup: ${describe(left)}`);
  const stillRunning = new Set(lines(run('docker', ['ps', '--format', '{{.ID}}'], { capture: true }).stdout));
  const gone = before.filter((c) => !stillRunning.has(c.id));
  log(`unrelated containers running before the rehearsal: ${before.length}; still running: ${before.length - gone.length}${before.length ? ` (${before.map((c) => c.name).join(', ')})` : ''}`);
  if (gone.length) log(`WARNING: no longer running (this script never targets them; check what else stopped them): ${gone.map((c) => c.name).join(', ')}`);
  const total = left.containers.length + left.volumes.length + left.networks.length + left.images.length;
  if (total > 0) throw new Error(`cleanup left resources of project "${PROJECT}": ${describe(left)}`);
}

async function main() {
  if (args.has('--init-env')) return initEnv();

  step('1. prerequisites and local environment');
  const [major] = process.versions.node.split('.').map(Number);
  if (major < 22) throw new Error(`Node.js 22+ required (found ${process.versions.node})`);
  run('docker', ['version', '--format', 'Docker server {{.Server.Version}}']);
  run('docker', ['compose', 'version']);
  const { port } = checkEnv();
  log(`env file OK (${ENV_FILE}): required secrets present and valid, OTP_HASH_SECRET dedicated and at least 32 characters (values not shown)`);
  log(`backend will be published on 127.0.0.1:${port}`);
  // --quiet: validates without printing the resolved file, which would contain the secrets.
  compose(['--profile', 'tools', 'config', '--quiet']);
  log('compose configuration is valid');

  step(`2. ensure a brand-new stack (scoped cleanup of project "${PROJECT}" only)`);
  const unrelated = unrelatedRunning();
  log(`unrelated running containers (left alone): ${unrelated.length ? unrelated.map((c) => c.name).join(', ') : 'none'}`);
  const existing = projectResources();
  log(`existing resources of project "${PROJECT}": ${describe(existing)}`);
  assertOwnership(existing);
  stackCreated = true;
  compose(['--profile', 'tools', 'down', '--volumes', '--remove-orphans'], { allowFail: true });

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

  step('8. start the backend (OTP_STORE=redis) and check health');
  compose(['up', '-d', 'backend']);
  log(`GET /health/live  -> ${await httpCheck(`http://127.0.0.1:${port}/health/live`)}`);
  log(`GET /health/ready -> ${await httpCheck(`http://127.0.0.1:${port}/health/ready`)}`);
  await waitHealthy('backend', 180_000);
  log('backend container health check: healthy');

  step('9. Redis health and the backend\'s effective OTP store');
  const pong = compose(['exec', '-T', 'redis', 'redis-cli', 'ping'], { capture: true }).stdout.trim();
  if (pong !== 'PONG') throw new Error(`redis-cli ping returned "${pong}"`);
  log('redis-cli ping -> PONG');
  // Only the store name and whether the secret is set leave the container, never its value.
  const effective = compose(['exec', '-T', 'backend', 'node', '-e',
    "const s=process.env.OTP_HASH_SECRET||'';console.log(JSON.stringify({store:process.env.OTP_STORE||null,secretSet:s.length>=32,redisUrlSet:Boolean(process.env.REDIS_URL)}))"], { capture: true }).stdout.trim();
  const env = JSON.parse(effective);
  log(`backend container: OTP_STORE=${env.store}; OTP_HASH_SECRET set (>= 32 characters): ${env.secretSet}; REDIS_URL set: ${env.redisUrlSet}`);
  if (env.store !== 'redis' || !env.secretSet || !env.redisUrlSet) throw new Error('the backend container is not configured for the Redis OTP store');
  const logs = compose(['logs', '--no-color', 'backend'], { capture: true }).stdout;
  if (!logs.includes('Redis connected.')) throw new Error('backend log has no "Redis connected." line');
  if (!logs.includes(REDIS_OTP_LOG)) throw new Error(`backend log has no "${REDIS_OTP_LOG}" line: the Redis OTP store was not selected`);
  if (logs.includes(MEMORY_OTP_LOG)) throw new Error('backend log shows the in-memory OTP store was selected');
  log(`backend log: "Redis connected." and "${REDIS_OTP_LOG}"; no in-memory OTP store`);
  // The running backend writes its OTP state to this Redis: one resend through the public route
  // creates a challenge and a cooldown key there; a second is refused by that cooldown. Synthetic
  // `.invalid` address; no code is returned, and nothing is delivered (no SMS or e-mail transport).
  const keysBefore = otpKeyCount();
  const identifier = `rehearsal-${randomBytes(6).toString('hex')}@pharmalink-staging.invalid`;
  const first = await post(`http://127.0.0.1:${port}/auth/resend-otp`, { identifier, purpose: 'REGISTER' });
  const keysAfter = otpKeyCount();
  const second = await post(`http://127.0.0.1:${port}/auth/resend-otp`, { identifier, purpose: 'REGISTER' });
  log(`POST /auth/resend-otp (synthetic .invalid address): first -> HTTP ${first.status}; OTP keys in the stack Redis ${keysBefore} -> ${keysAfter}; second -> HTTP ${second.status} ${second.errorCode ?? ''}`.trimEnd());
  if (first.status < 200 || first.status >= 300) throw new Error(`first resend returned HTTP ${first.status} ${first.errorCode ?? ''}`);
  if (keysAfter !== keysBefore + 2) throw new Error(`expected 2 new OTP keys (challenge and cooldown) in the stack Redis, found ${keysAfter - keysBefore}`);
  if (second.status !== 429 || second.errorCode !== 'RATE_LIMITED') throw new Error(`second resend returned HTTP ${second.status} ${second.errorCode ?? ''}, expected 429 RATE_LIMITED (cooldown)`);

  step('10. OTP smoke test (RedisOtpService via the real DI binding, in the tools image)');
  compose(['run', '--rm', 'tools', 'npx', 'ts-node', 'test/staging/otp-store.smoke.ts']);

  step('11. prisma migrate deploy again (must find nothing pending)');
  const again = compose(['run', '--rm', 'tools', 'npx', 'prisma', 'migrate', 'deploy'], { capture: true });
  const output = `${again.stdout}${again.stderr}`;
  process.stdout.write(output);
  if (!/No pending migrations to apply/i.test(output)) throw new Error('second migrate deploy did not report "No pending migrations to apply"');

  log('\n=== REHEARSAL PASSED');
  return unrelated;
}

// Keeps the event loop alive for the whole run: fetch sockets and abort timers are unref'd, and a
// request held open by Docker's port proxy before the app listens must not let Node exit mid-step.
const keepAlive = setInterval(() => {}, 1000);
try {
  const unrelated = await main();
  if (stackCreated) {
    if (KEEP) log(`\n--keep: stack left running. Remove it later with:\n  docker compose -p ${PROJECT} -f compose.staging.yml --env-file backend/.env.staging --profile tools down --volumes --remove-orphans --rmi local`);
    else {
      cleanup('success');
      currentStep = 'cleanup verification';
      verifyCleanup(unrelated);
    }
  }
} catch (err) {
  console.error(`\n=== REHEARSAL FAILED at step: ${currentStep}\n${err.message}`);
  if (stackCreated) {
    compose(['logs', '--no-color', '--tail', '80', 'backend'], { allowFail: true });
    if (KEEP) log(`\n--keep: stack left in place for debugging (project "${PROJECT}").`);
    else cleanup('failure');
  }
  process.exitCode = 1;
} finally {
  clearInterval(keepAlive);
}
