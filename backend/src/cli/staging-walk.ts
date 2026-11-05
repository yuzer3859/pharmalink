import { writeFileSync } from 'fs';
import { join } from 'path';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_FEATURE_FLAG,
  FIXTURE_ORDERS,
  FIXTURE_ORGANIZATIONS,
  FIXTURE_PRODUCTS,
  WalkRound,
} from './staging-seed/fixtures';
import { createTerminalPrompter } from './terminal-prompter';

/**
 * `npm run staging:walk` (Work 80): the owner's live walk of every admin page against the staging
 * stack, run from `backend/` on the host while the stack is up. The owner types the e-mail,
 * password and authenticator code; the session lives in this process's memory only and is never
 * printed or written. The walk then makes, through the HTTP API, every read and every action the
 * portal's admin pages make, against the seeded fixtures of the signed-in role's round, and prints
 * a report (also saved as JSON without any secret) of what each call returned.
 *
 * It judges nothing on its own: a 403 is reported as a 403. Which outcomes are correct for which
 * role is decided when the report is reviewed against the role catalogue.
 */

interface Step {
  page: string;
  action: string;
  method: string;
  path: string;
  status: number | null;
  code: string | null;
  message: string | null;
  note?: string;
}

const DEVICE = { fingerprint: 'staging-walk-cli', platform: 'WEB', name: 'Staging walk (CLI)' };
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

class Walk {
  readonly steps: Step[] = [];
  private token: string | null = null;

  constructor(private readonly base: string) {}

  authenticate(token: string): void {
    this.token = token;
  }

  async call<T = unknown>(
    page: string,
    action: string,
    method: string,
    path: string,
    body?: unknown,
    note?: string,
  ): Promise<{ ok: boolean; data: T | null }> {
    const step: Step = { page, action, method, path, status: null, code: null, message: null, note };
    try {
      const res = await fetch(`${this.base}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      step.status = res.status;
      const text = await res.text();
      const payload = text ? (JSON.parse(text) as { success?: boolean; data?: T; error?: { code?: string; message?: string } }) : {};
      if (!res.ok) {
        step.code = payload.error?.code ?? null;
        step.message = payload.error?.message ?? null;
      }
      this.steps.push(step);
      return { ok: res.ok, data: (payload.data ?? null) as T | null };
    } catch (err) {
      step.code = 'NETWORK_ERROR';
      step.message = err instanceof Error ? err.message : 'unknown';
      this.steps.push(step);
      return { ok: false, data: null };
    }
  }

  /** A fixture the walk needed but could not find: recorded as a failed step, nothing is called. */
  missing(page: string, action: string, what: string): void {
    this.steps.push({ page, action, method: '-', path: '-', status: null, code: 'FIXTURE_NOT_FOUND', message: what });
  }
}

const q = (params: Record<string, string | number>) =>
  `?${Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&')}`;

interface Page<T> {
  items: T[];
  total: number;
}

async function userIdOf(walk: Walk, identifier: string): Promise<string | null> {
  const res = await walk.call<Page<{ id?: string; userId?: string }>>('Accounts', `find ${identifier}`, 'GET', `/admin/accounts${q({ identifier, page: 1, size: 5 })}`);
  const row = res.data?.items[0];
  return row ? (row.userId ?? row.id ?? null) : null;
}

async function pendingRequest(walk: Walk, userId: string, type: string): Promise<string | null> {
  const res = await walk.call<Page<{ requestId: string; userId: string; type: string }>>(
    'Verifications',
    `find pending ${type}`,
    'GET',
    `/admin/verifications${q({ status: 'PENDING', type, page: 1, size: 100 })}`,
  );
  return res.data?.items.find((i) => i.userId === userId)?.requestId ?? null;
}

const roundSuffix = (round: WalkRound) => (round === 'admin' ? '' : 'SuperAdmin');

async function walkReads(walk: Walk): Promise<void> {
  const reads: Array<[string, string]> = [
    ['Dashboard / Analytics', '/admin/analytics/overview'],
    ['Audit Logs', `/admin/audit${q({ page: 1, size: 20 })}`],
    ['Accounts', `/admin/accounts${q({ page: 1, size: 20 })}`],
    ['Roles', '/admin/roles'],
    ['Pharmacies', `/admin/operations/pharmacies${q({ page: 1, size: 20 })}`],
    ['Orders', `/admin/operations/orders${q({ page: 1, size: 20 })}`],
    ['Inventory', `/admin/operations/inventory/listings${q({ page: 1, size: 20 })}`],
    ['Verifications', `/admin/verifications${q({ status: 'PENDING', page: 1, size: 20 })}`],
    ['Catalogue review', `/admin/catalog/review${q({ page: 1, size: 20 })}`],
    ['Catalogue review', '/admin/catalog/review/summary'],
    ['Finance', '/admin/finance/overview'],
    ['Finance', `/admin/finance/payments${q({ page: 1, size: 20 })}`],
    ['Finance', `/admin/finance/refunds${q({ page: 1, size: 20 })}`],
    ['Finance', `/admin/finance/settlements${q({ page: 1, size: 20 })}`],
    ['COD disputes', `/admin/cod-disputes${q({ page: 1, size: 20 })}`],
    ['Configuration', '/admin/config'],
    ['Configuration', '/admin/feature-flags'],
  ];
  for (const [page, path] of reads) await walk.call(page, 'load', 'GET', path);

  // One detail view per page that has a drawer.
  const audit = await walk.call<Page<{ id: string }>>('Audit Logs', 'list for detail', 'GET', `/admin/audit${q({ page: 1, size: 1 })}`);
  if (audit.data?.items[0]) await walk.call('Audit Logs', 'detail', 'GET', `/admin/audit/${audit.data.items[0].id}`);
  const orders = await walk.call<Page<{ id: string }>>('Orders', 'list for detail', 'GET', `/admin/operations/orders${q({ page: 1, size: 1 })}`);
  if (orders.data?.items[0]) await walk.call('Orders', 'detail', 'GET', `/admin/operations/orders/${orders.data.items[0].id}`);
  const listings = await walk.call<Page<{ id?: string; listingId?: string }>>('Inventory', 'list for detail', 'GET', `/admin/operations/inventory/listings${q({ page: 1, size: 1 })}`);
  const listing = listings.data?.items[0];
  if (listing) await walk.call('Inventory', 'detail', 'GET', `/admin/operations/inventory/listings/${listing.listingId ?? listing.id}`);
  const payments = await walk.call<Page<{ id: string }>>('Finance', 'list for detail', 'GET', `/admin/finance/payments${q({ page: 1, size: 1 })}`);
  if (payments.data?.items[0]) await walk.call('Finance', 'payment detail', 'GET', `/admin/finance/payments/${payments.data.items[0].id}`);
  const settlements = await walk.call<Page<{ id: string }>>('Finance', 'list for detail', 'GET', `/admin/finance/settlements${q({ page: 1, size: 1 })}`);
  if (settlements.data?.items[0]) await walk.call('Finance', 'settlement detail', 'GET', `/admin/finance/settlements/${settlements.data.items[0].id}`);
}

async function walkAccounts(walk: Walk): Promise<void> {
  const target = FIXTURE_ACCOUNTS.find((a) => a.key === 'walkTarget')!;
  const userId = await userIdOf(walk, target.phone!);
  if (!userId) return walk.missing('Accounts', 'suspend / reinstate / roles', 'the walk target account');
  await walk.call('Accounts', 'detail', 'GET', `/admin/accounts/${userId}`);
  await walk.call('Accounts', 'suspend', 'POST', `/admin/accounts/${userId}/suspend`, { reason: 'Staging walk: suspension check.' });
  await walk.call('Accounts', 'reinstate', 'POST', `/admin/accounts/${userId}/reinstate`, { reason: 'Staging walk: reinstated.' });
  const assigned = await walk.call<{ assignment?: { id: string }; assignmentId?: string }>('Accounts', 'assign role CUSTOMER_SUPPORT', 'POST', `/admin/accounts/${userId}/roles`, { roleKey: 'CUSTOMER_SUPPORT' });
  const roles = await walk.call<Array<{ assignmentId?: string; id?: string; roleKey?: string; role?: { key: string } }>>('Accounts', 'roles', 'GET', `/admin/accounts/${userId}/roles`);
  const assignment =
    assigned.data?.assignmentId ??
    assigned.data?.assignment?.id ??
    roles.data?.find((r) => (r.roleKey ?? r.role?.key) === 'CUSTOMER_SUPPORT')?.assignmentId ??
    roles.data?.find((r) => (r.roleKey ?? r.role?.key) === 'CUSTOMER_SUPPORT')?.id;
  if (assignment) await walk.call('Accounts', 'revoke role CUSTOMER_SUPPORT', 'DELETE', `/admin/accounts/${userId}/roles/${assignment}`);
  else if (assigned.ok) walk.missing('Accounts', 'revoke role CUSTOMER_SUPPORT', 'the assignment just made');
}

async function walkVerifications(walk: Walk, round: WalkRound): Promise<void> {
  const s = roundSuffix(round);
  const org = (key: string) => FIXTURE_ORGANIZATIONS.find((o) => o.key === `${key}${s}`)!;
  const account = (key: string) => FIXTURE_ACCOUNTS.find((a) => a.key === `${key}${s}`)!;

  const decisions: Array<{ identifier: string; type: string; approve: boolean; label: string }> = [
    { identifier: org('pendingApprove').ownerEmail, type: 'PHARMACY_LICENSE', approve: true, label: org('pendingApprove').legalName },
    { identifier: org('pendingReject').ownerEmail, type: 'PHARMACY_LICENSE', approve: false, label: org('pendingReject').legalName },
    { identifier: account('customerFayda').phone!, type: 'FAYDA', approve: true, label: 'FAYDA' },
    { identifier: account('driverPending').phone!, type: 'DRIVER_DOCS', approve: true, label: 'DRIVER_DOCS' },
    { identifier: account('doctorPending').phone!, type: 'DOCTOR_LICENSE', approve: false, label: 'DOCTOR_LICENSE' },
  ];
  for (const d of decisions) {
    const userId = await userIdOf(walk, d.identifier);
    const requestId = userId ? await pendingRequest(walk, userId, d.type) : null;
    if (!requestId) {
      walk.missing('Verifications', `${d.approve ? 'approve' : 'reject'} ${d.label}`, `a pending ${d.type} request (already decided by an earlier walk?)`);
      continue;
    }
    await walk.call('Verifications', `detail ${d.label}`, 'GET', `/admin/verifications/${requestId}`);
    if (d.approve) {
      const body: Record<string, string> = { expiresAt: new Date(Date.now() + YEAR_MS).toISOString(), reason: 'Staging walk: documents checked.' };
      if (d.type === 'PHARMACY_LICENSE') body.licenseNumber = `STG-WALK-${round === 'admin' ? 'A' : 'S'}-0001`;
      await walk.call('Verifications', `approve ${d.label}`, 'POST', `/admin/verifications/${requestId}/approve`, body);
    } else {
      await walk.call('Verifications', `reject ${d.label}`, 'POST', `/admin/verifications/${requestId}/reject`, {
        reason: 'Staging walk: the document is not legible.',
      });
    }
  }
}

async function walkPharmacyActivation(walk: Walk, round: WalkRound): Promise<void> {
  const fixture = FIXTURE_ORGANIZATIONS.find((o) => o.key === `awaitingActivation${roundSuffix(round)}`)!;
  const page = await walk.call<Page<{ pharmacyId: string; displayName?: string; transactingStatus: string }>>(
    'Pharmacies',
    'find pending pharmacies',
    'GET',
    `/admin/operations/pharmacies${q({ transactingStatus: 'PENDING', page: 1, size: 100 })}`,
  );
  const row = page.data?.items.find((p) => p.displayName === fixture.legalName);
  if (!row) {
    const unnamed = page.data?.items.some((p) => p.displayName === undefined);
    return walk.missing(
      'Pharmacies',
      `activate ${fixture.legalName}`,
      unnamed ? 'pharmacy rows carry no name, so the fixture cannot be told apart' : 'the pharmacy (already activated by an earlier walk?)',
    );
  }
  await walk.call('Pharmacies', `detail ${fixture.legalName}`, 'GET', `/admin/operations/pharmacies/${row.pharmacyId}`);
  await walk.call('Pharmacies', `activate ${fixture.legalName}`, 'POST', '/pharmacy/activate', { pharmacyId: row.pharmacyId });
}

async function walkCatalogue(walk: Walk, round: WalkRound): Promise<void> {
  const s = roundSuffix(round);
  const actions: Array<[string, 'submit' | 'approve' | 'reject' | 'resubmit']> = [
    ['draft', 'submit'],
    ['pendingApprove', 'approve'],
    ['pendingReject', 'reject'],
    ['rejected', 'resubmit'],
  ];
  for (const [key, action] of actions) {
    const product = FIXTURE_PRODUCTS.find((p) => p.key === `${key}${s}`)!;
    const page = await walk.call<Page<{ id: string; nameEn: string | null; status: string }>>(
      'Catalogue review',
      `find ${product.nameEn}`,
      'GET',
      `/admin/catalog/review${q({ q: product.nameEn, status: 'all', page: 1, size: 20 })}`,
    );
    const row = page.data?.items.find((i) => i.nameEn === product.nameEn);
    if (!row || row.status !== product.outcome) {
      walk.missing('Catalogue review', `${action} ${product.nameEn}`, row ? `the product is ${row.status}, not ${product.outcome} (an earlier walk?)` : 'the product');
      continue;
    }
    await walk.call('Catalogue review', `history ${product.nameEn}`, 'GET', `/admin/catalog/review/${row.id}/history`);
    await walk.call(
      'Catalogue review',
      `${action} ${product.nameEn}`,
      'POST',
      `/admin/catalog/review/${row.id}/${action}`,
      action === 'reject' ? { reason: 'Staging walk: the pack size is missing.' } : undefined,
    );
  }
}

async function walkCodDispute(walk: Walk, round: WalkRound): Promise<void> {
  const fixture = FIXTURE_ORDERS.find((o) => o.key === `codDisputed${roundSuffix(round)}`)!;
  const orders = await walk.call<Page<{ id: string }>>('Orders', `find ${fixture.orderNumber}`, 'GET', `/admin/operations/orders${q({ orderNumber: fixture.orderNumber, page: 1, size: 5 })}`);
  const orderId = orders.data?.items[0]?.id;
  if (!orderId) return walk.missing('COD disputes', `resolve ${fixture.orderNumber}`, 'the order');
  const disputes = await walk.call<Page<{ dispute: { id: string; status: string } }>>('COD disputes', `find ${fixture.orderNumber}`, 'GET', `/admin/cod-disputes${q({ orderId, page: 1, size: 5 })}`);
  const open = disputes.data?.items.find((i) => i.dispute.status === 'OPEN');
  if (!open) return walk.missing('COD disputes', `resolve ${fixture.orderNumber}`, 'an open dispute (already resolved by an earlier walk?)');
  await walk.call('COD disputes', `detail ${fixture.orderNumber}`, 'GET', `/admin/cod-disputes/${open.dispute.id}`);
  await walk.call('COD disputes', `resolve ${fixture.orderNumber}`, 'POST', `/admin/cod-disputes/${open.dispute.id}/resolve`, {
    resolutionNote: 'Staging walk: shortfall confirmed with the driver.',
  });
}

async function walkConfiguration(walk: Walk): Promise<void> {
  await walk.call('Configuration', `toggle ${FIXTURE_FEATURE_FLAG} on`, 'PUT', `/admin/feature-flags/${FIXTURE_FEATURE_FLAG}`, { enabled: true });
  await walk.call('Configuration', `toggle ${FIXTURE_FEATURE_FLAG} off`, 'PUT', `/admin/feature-flags/${FIXTURE_FEATURE_FLAG}`, { enabled: false });

  // Publish the effective value twice, then roll back to the first publication: every step runs,
  // and the setting's value never changes.
  const settings = await walk.call<Array<{ namespace: string; key: string; valueType: string; effectiveValue: unknown }>>('Configuration', 'list for publish', 'GET', '/admin/config');
  const setting = settings.data?.find((c) => c.valueType === 'NUMBER') ?? settings.data?.[0];
  if (!setting) return walk.missing('Configuration', 'publish / rollback', 'a configuration setting');
  const path = `/admin/config/${encodeURIComponent(setting.namespace)}/${encodeURIComponent(setting.key)}`;
  const body = { valueType: setting.valueType, value: setting.effectiveValue, reason: 'Staging walk: republished unchanged.' };
  const first = await walk.call<{ version?: number; activeVersion?: number }>('Configuration', `publish ${setting.namespace}.${setting.key}`, 'PUT', path, body);
  await walk.call('Configuration', `publish ${setting.namespace}.${setting.key} again`, 'PUT', path, body);
  await walk.call('Configuration', `history ${setting.namespace}.${setting.key}`, 'GET', `${path}/history`);
  const toVersion = first.data?.version ?? first.data?.activeVersion;
  if (toVersion === undefined) return walk.missing('Configuration', 'rollback', 'the version number of the first publication');
  await walk.call('Configuration', `rollback ${setting.namespace}.${setting.key} to v${toVersion}`, 'POST', `${path}/rollback`, {
    toVersion,
    reason: 'Staging walk: rollback check.',
  });
}

async function signIn(walk: Walk, base: string): Promise<{ round: WalkRound; role: string } | null> {
  const io = createTerminalPrompter();
  try {
    const identifier = (await io.ask('E-mail: ')).trim();
    const password = await io.askHidden('Password (not shown): ');
    const login = await fetch(`${base}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ identifier, password, deviceInfo: DEVICE }),
    });
    const loginBody = (await login.json()) as { data?: { accessToken?: string; mfaRequired?: boolean; challenge?: { type: string; token: string } }; error?: { message?: string } };
    let token = loginBody.data?.accessToken ?? null;
    const challenge = loginBody.data?.challenge;
    if (!token && challenge?.type === 'ENROLLMENT') {
      io.print('This account has no authenticator yet. Sign in once in the portal to enrol it, then run the walk again.');
      return null;
    }
    if (!token && challenge?.type === 'TOTP') {
      const code = (await io.ask('Authenticator code: ')).replace(/\s/g, '');
      const verify = await fetch(`${base}/auth/mfa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ challengeToken: challenge.token, code, deviceInfo: DEVICE }),
      });
      const verified = (await verify.json()) as { data?: { accessToken?: string }; error?: { message?: string } };
      token = verified.data?.accessToken ?? null;
      if (!token) io.print(`Sign-in failed: ${verified.error?.message ?? verify.status}`);
    } else if (!token) {
      io.print(`Sign-in failed: ${loginBody.error?.message ?? login.status}`);
    }
    if (!token) return null;
    walk.authenticate(token);
    const me = await walk.call<{ primaryRole?: string }>('Session', 'who am I', 'GET', '/users/me');
    const role = me.data?.primaryRole ?? 'UNKNOWN';
    io.print(`Signed in as ${role}.`);
    return { round: role === 'SUPER_ADMIN' ? 'superAdmin' : 'admin', role };
  } finally {
    io.close();
  }
}

async function main(): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('Run this in an interactive terminal: the password and code are read from the keyboard.');
    process.exitCode = 2;
    return;
  }
  const base = (process.env.STAGING_API_URL ?? 'http://127.0.0.1:3000').replace(/\/+$/, '');
  if (!/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(base)) {
    console.error('The walk only runs against the local staging stack (http://127.0.0.1:<port>).');
    process.exitCode = 2;
    return;
  }
  const walk = new Walk(base);
  const session = await signIn(walk, base);
  if (!session) {
    process.exitCode = 2;
    return;
  }

  await walkReads(walk);
  await walkAccounts(walk);
  await walkVerifications(walk, session.round);
  await walkPharmacyActivation(walk, session.round);
  await walkCatalogue(walk, session.round);
  await walkCodDispute(walk, session.round);
  await walkConfiguration(walk);

  const failed = walk.steps.filter((s) => s.status === null || s.status >= 400);
  for (const s of walk.steps) {
    const outcome = s.status === null ? 'FAIL' : s.status < 400 ? ' ok ' : `${s.status}`;
    console.log(`${outcome.padEnd(5)} ${s.page.padEnd(22)} ${s.action}${s.code ? `  -> ${s.code}: ${s.message ?? ''}` : ''}`);
  }
  const file = join(process.cwd(), `staging-walk-${session.round}.json`);
  writeFileSync(
    file,
    JSON.stringify({ role: session.role, round: session.round, at: new Date().toISOString(), steps: walk.steps }, null, 2),
  );
  console.log(`\n${walk.steps.length} calls, ${failed.length} not successful. Report saved to ${file} (no secrets in it).`);
}

main().catch((err: unknown) => {
  console.error(`The walk stopped: ${err instanceof Error ? err.message : 'unknown error'}`);
  process.exitCode = 1;
});
