import { INestApplicationContext } from '@nestjs/common';
import { AcceptFulfillmentCommand } from '../modules/orders/application/commands/accept-fulfillment.command';
import { MarkReadyCommand } from '../modules/orders/application/commands/mark-ready.command';
import { PrepareFulfillmentCommand } from '../modules/orders/application/commands/prepare-fulfillment.command';
import { ApprovePrescriptionCommand } from '../modules/prescription-matching/application/commands/approve-prescription.command';
import { AssignVerifyingPharmacyCommand } from '../modules/prescription-matching/application/commands/assign-verifying-pharmacy.command';
import { AcceptJobOfferCommand } from '../modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../modules/delivery/application/commands/advance-delivery-job.command';
import { CaptureProofOfDeliveryCommand } from '../modules/delivery/application/commands/capture-proof-of-delivery.command';
import { DispatchDeliveryJobCommand } from '../modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageDriverShiftCommand } from '../modules/delivery/application/commands/manage-driver-shift.command';
import { SetDriverAvailabilityCommand } from '../modules/delivery/application/commands/set-driver-availability.command';
import { UpdateDriverLocationCommand } from '../modules/delivery/application/commands/update-driver-location.command';
import { DispatchOutcome } from '../modules/delivery/application/commands/dispatch-delivery-job.command';
import { DeliveryJobStatus, DriverAvailability, PodType } from '../modules/delivery/domain/enums';
import { userVerifiedEvent } from '../modules/identity/domain/events';
import { RunSettlementCommand } from '../modules/payment/application/commands/run-settlement.command';
import { FIRST_SETTLEMENT_PERIOD_START } from '../modules/payment/application/services/settlement-auto-run.service';
import { AccountingReconciliationService } from '../modules/payment/application/services/accounting-reconciliation.service';
import { IUserRepository, USER_REPOSITORY } from '../modules/identity/domain/repositories/user.repository';
import { AuditService } from '../shared/audit/audit.service';
import { OutboxService } from '../shared/outbox/outbox.service';
import { declareCliProcess } from '../shared/config/process-role';
import { PrismaService } from '../shared/prisma/prisma.service';
import { FIXTURE_ACCOUNTS, FIXTURE_ORGANIZATIONS } from './staging-seed/fixtures';
import { createStagingContext, StagingRefusedError } from './staging-seed/staging-context';

/**
 * Work 103: the other side of the Phase 1 staging walk. The customer uses the customer app; this
 * acts as the seeded pharmacy and the seeded driver through the application's own commands, the
 * same ones their apps call (the pharmacy portal's order pages and the driver app are outside the
 * Phase 1 mission). Staging only: `createStagingContext` refuses any other database.
 *
 *   npm run staging:actors -- verify-customer <e-mail>       mark a new customer's e-mail verified (Work 105)
 *   npm run staging:actors -- pharmacist <customer e-mail>   approve that customer's newest prescription
 *   npm run staging:actors -- pharmacy <order number>        accept, prepare, mark ready
 *   npm run staging:actors -- statement now                 the walk pharmacy's statement, as the automatic run makes it (Work 105)
 *   npm run staging:actors -- reconciliation all              the finance reconciliation report, read-only (Work 105)
 *   npm run staging:actors -- driver <order number>          accept the job, pick up, deliver with proof
 *
 * Events these commands write are relayed by the running staging backend (capture at ready, the
 * delivery job and its dispatch, the order following its delivery).
 */

const EXIT_REFUSED = 2;
const EXIT_USAGE = 64;
const WALK_PHARMACY = FIXTURE_ORGANIZATIONS.find((o) => o.key === 'transacting')!;
/** Work 105: the walk driver, then a spare for a job whose offer to the first one expired. */
const WALK_DRIVER_PHONES = ['driverCod', 'driverWalkSpare'].map((key) => FIXTURE_ACCOUNTS.find((a) => a.key === key)!.phone!);

type Log = (line: string) => void;

async function walkPharmacy(prisma: PrismaService) {
  const org = await prisma.organization.findFirstOrThrow({ where: { name: WALK_PHARMACY.legalName } });
  return { organizationId: org.id, ownerUserId: org.ownerUserId };
}

async function orderByNumber(prisma: PrismaService, orderNumber: string) {
  const order = await prisma.order.findUnique({ where: { orderNumber } });
  if (!order) throw new Error(`No order ${orderNumber}.`);
  return order;
}

/**
 * Work 105: Resend's test sender delivers only to the owner's own address, which on staging is the
 * Super Admin, so a walk customer can never receive the sign-up code. This marks one newly
 * registered customer's e-mail verified, as the code would have: only a CUSTOMER account (holding no role but CUSTOMER) still
 * PENDING_VERIFICATION, through the domain (`markEmailVerified`), with the same
 * `identity.user.verified` event, and audited. Staging only, like every actor here.
 */
export async function verifyCustomer(app: INestApplicationContext, email: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const row = await prisma.user.findFirst({ where: { email: email.toLowerCase() }, include: { userRoles: { include: { role: true } } } });
  if (!row) throw new Error(`No account ${email}. Sign up in the customer app first.`);
  if (row.primaryRole !== 'CUSTOMER' || row.userRoles.some((r) => r.role.key !== 'CUSTOMER')) throw new Error(`${email} is not a customer account; only customers can be verified this way.`);
  if (row.status !== 'PENDING_VERIFICATION' || row.emailVerifiedAt) throw new Error(`${email} is not waiting for verification (status ${row.status}).`);
  const users = app.get<IUserRepository>(USER_REPOSITORY);
  const user = await users.findByIdentifier(row.email!);
  if (!user) throw new Error(`No account ${email}.`);
  user.markEmailVerified();
  await users.save(user);
  await app.get(OutboxService).write(userVerifiedEvent({ userId: user.id, method: 'EMAIL' }));
  await app.get(AuditService).record({
    actorUserId: null,
    action: 'staging.customer.email_verified',
    resourceType: 'user',
    resourceId: user.id,
    context: { reason: 'Resend test sender cannot deliver the sign-up code to this address', tool: 'staging:actors' },
  });
  log(`${email}: e-mail verified. Sign in with your password in the customer app.`);
}

export async function pharmacist(app: INestApplicationContext, email: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const customer = await prisma.user.findFirst({ where: { email: email.toLowerCase() } });
  if (!customer) throw new Error(`No customer ${email}.`);
  const rx = await prisma.prescription.findFirst({ where: { customerUserId: customer.id, status: 'UPLOADED' }, orderBy: { createdAt: 'desc' } });
  if (!rx) throw new Error('That customer has no uploaded prescription waiting for review.');
  const cart = await prisma.cart.findFirst({ where: { customerUserId: customer.id, status: 'ACTIVE' }, include: { items: true } });
  const rxItems = (cart?.items ?? []).filter((i) => i.requiresRx);
  if (rxItems.length === 0) throw new Error("The customer's cart has no prescription medicine to approve.");
  const pharmacy = await walkPharmacy(prisma);
  await app.get(AssignVerifyingPharmacyCommand).execute({ prescriptionId: rx.id, pharmacyId: pharmacy.organizationId });
  await app.get(ApprovePrescriptionCommand).execute({
    prescriptionId: rx.id,
    reviewerUserId: pharmacy.ownerUserId,
    lines: rxItems.map((i) => ({ catalogProductId: i.catalogProductId, approvedQuantity: Math.max(i.quantity, 10), refillsAllowed: 0, isSingleUse: false })),
    legibilityOk: true,
    validityOk: true,
  });
  log(`Approved prescription ${rx.id} for ${rxItems.length} product(s) at ${WALK_PHARMACY.legalName}.`);
}

export async function pharmacy(app: INestApplicationContext, orderNumber: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const order = await orderByNumber(prisma, orderNumber);
  const fulfillment = await prisma.fulfillment.findFirstOrThrow({ where: { orderId: order.id } });
  const { ownerUserId } = await walkPharmacy(prisma);
  const input = { fulfillmentId: fulfillment.id, actorUserId: ownerUserId };
  if (fulfillment.status === 'PENDING') await app.get(AcceptFulfillmentCommand).execute(input);
  if ((await prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status === 'ACCEPTED') await app.get(PrepareFulfillmentCommand).execute(input);
  if ((await prisma.fulfillment.findUniqueOrThrow({ where: { id: fulfillment.id } })).status === 'PREPARING') await app.get(MarkReadyCommand).execute(input);
  log(`Order ${orderNumber}: accepted, prepared and ready (${(await prisma.order.findUniqueOrThrow({ where: { id: order.id } })).status}).`);
}

export async function driver(app: INestApplicationContext, orderNumber: string, log: Log, waitMs = 60_000): Promise<void> {
  const prisma = app.get(PrismaService);
  const order = await orderByNumber(prisma, orderNumber);
  const started = Date.now();
  let job = await prisma.deliveryJob.findFirst({ where: { orderId: order.id } });
  while (!job && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 2_000));
    job = await prisma.deliveryJob.findFirst({ where: { orderId: order.id } });
  }
  if (!job) throw new Error('No delivery job yet: is the order ready, and is the staging backend running?');
  const user = await walkDriverFor(app, job, log);
  try {
    await deliver(app, job.id, user.id, orderNumber, log);
  } finally {
    // Off again, so the backend does not offer the next walk job on its own while this tool is
    // not there to accept it within the offer's TTL (Work 105).
    await app.get(SetDriverAvailabilityCommand).execute({ userId: user.id, availability: DriverAvailability.OFFLINE });
  }
}

/**
 * The driver who will carry this job, holding an accepted offer. A live offer is accepted at once by
 * whoever holds it; otherwise the first walk driver never offered this job goes on shift, online
 * and to the pickup, is offered it, and accepts it straight away (offers live 30 seconds).
 */
async function walkDriverFor(app: INestApplicationContext, job: { id: string; status: string; assignedDriverId: string | null; pickupLat: number | null; pickupLng: number | null }, log: Log) {
  const prisma = app.get(PrismaService);
  const users = await prisma.user.findMany({ where: { phone: { in: WALK_DRIVER_PHONES } } });
  const profiles = await prisma.driverProfile.findMany({ where: { userId: { in: users.map((u) => u.id) } } });
  // Walk order, each with its delivery profile; a fixture driver the seed has not set up is skipped.
  const byPhone = WALK_DRIVER_PHONES.flatMap((phone) => {
    const user = users.find((u) => u.phone === phone);
    const profile = user && profiles.find((p) => p.userId === user.id);
    return user && profile ? [{ id: user.id, phone, profileId: profile.id }] : [];
  });
  if (job.assignedDriverId) {
    const assigned = byPhone.find((d) => d.profileId === job.assignedDriverId);
    if (!assigned) throw new Error('This job is carried by a driver the walk does not control.');
    return assigned;
  }
  const offers = await prisma.jobOffer.findMany({ where: { jobId: job.id } });
  const live = offers.find((o) => o.status === 'OFFERED' && o.expiresAt.getTime() > Date.now() + 2_000);
  let holder = live ? byPhone.find((d) => d.profileId === live.driverId) : undefined;
  if (!holder) {
    const offered = new Set(offers.map((o) => o.driverId));
    const fresh = byPhone.find((d) => !offered.has(d.profileId));
    if (!fresh) throw new Error('Every walk driver has already been offered this job; dispatch will not offer it to them again.');
    await app.get(ManageDriverShiftCommand).start({ userId: fresh.id });
    await app.get(SetDriverAvailabilityCommand).execute({ userId: fresh.id, availability: DriverAvailability.ONLINE });
    if (job.pickupLat !== null && job.pickupLng !== null) {
      await app.get(UpdateDriverLocationCommand).execute({ userId: fresh.id, lat: job.pickupLat, lng: job.pickupLng });
    }
    log(`  driver ${fresh.phone} on shift, online, at the pharmacy`);
    const dispatched = await app.get(DispatchDeliveryJobCommand).execute({ jobId: job.id, actorUserId: null });
    if (dispatched.outcome === DispatchOutcome.NoCandidate || !dispatched.offer) {
      throw new Error('Dispatch found no eligible driver (online, on shift, in the service area, verified, under the job limit).');
    }
    const offerDriverId = dispatched.offer.driverId;
    holder = byPhone.find((d) => d.profileId === offerDriverId);
    if (!holder) throw new Error('Dispatch offered the job to a driver the walk does not control.');
  }
  await app.get(AcceptJobOfferCommand).execute({ userId: holder.id, jobId: job.id });
  log(`  offer accepted by ${holder.phone}`);
  return holder;
}

async function deliver(app: INestApplicationContext, jobId: string, userId: string, orderNumber: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const job = { id: jobId };
  const user = { id: userId };
  const advance = app.get(AdvanceDeliveryJobCommand);
  for (const to of [DeliveryJobStatus.ARRIVED_PICKUP, DeliveryJobStatus.PICKED_UP, DeliveryJobStatus.EN_ROUTE, DeliveryJobStatus.ARRIVED_DROPOFF]) {
    const current = (await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } })).status;
    if (current === to) continue;
    await advance.byDriver({ userId: user.id, jobId: job.id, to });
    log(`  ${to}`);
  }
  if (!(await prisma.proofOfDelivery.findUnique({ where: { jobId: job.id } }))) {
    await app.get(CaptureProofOfDeliveryCommand).execute({ userId: user.id, jobId: job.id, type: PodType.CONFIRMATION, recipientName: 'Staging customer', recipientConfirmed: true });
  }
  await advance.byDriver({ userId: user.id, jobId: job.id, to: DeliveryJobStatus.DELIVERED });
  log(`Order ${orderNumber}: delivered with proof of delivery.`);
}

/**
 * Work 105: the operations portal has no "run statement" action, and the automatic run (Work 97)
 * waits for an amount or a period the walk never reaches. This makes the walk pharmacy's next
 * statement exactly as the automatic run does (from the last statement's end to now, no actor).
 * Approving it and paying it out stay with the finance officers in the portal (maker-checker).
 */
export async function statement(app: INestApplicationContext, _now: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const { organizationId } = await walkPharmacy(prisma);
  const pharmacy = await prisma.pharmacy.findUniqueOrThrow({ where: { organizationId } });
  const currency = 'ETB';
  const last = await prisma.settlement.findFirst({ where: { pharmacyId: pharmacy.id, currency }, orderBy: { periodEnd: 'desc' } });
  const periodStart = last?.periodEnd ?? FIRST_SETTLEMENT_PERIOD_START;
  const result = await app.get(RunSettlementCommand).execute({ pharmacyId: pharmacy.id, currency, periodStart, periodEnd: new Date(), actorUserId: null });
  log(`Statement ${result.settlement.id} for ${WALK_PHARMACY.legalName}: ${result.settlement.status}, net payable ${result.settlement.netPayable} santim, ${result.lines.length} line(s).`);
}

/**
 * Work 105: the finance reconciliation report (`GET /admin/finance/reconciliation`) has no portal
 * page yet, so the walk reads it here: the same service, read-only, printing what it found.
 */
export async function reconciliation(app: INestApplicationContext, _scope: string, log: Log): Promise<void> {
  const report = await app.get(AccountingReconciliationService).run({});
  const e = report.examined;
  log(`Reconciliation: ${report.anomalies.length === 0 ? 'CLEAN' : 'DISCREPANCIES_FOUND'}, ${report.anomalies.length} discrepancy(ies).`);
  log(`  examined ${e.capturedPayments} captured payment(s), ${e.settlements} statement(s), ${e.settlementLines} line(s), ${e.currencies} currency(ies)`);
  for (const a of report.anomalies) log(`  ${a.kind} ${a.subject}: ${a.message}`);
}

async function main(): Promise<void> {
  declareCliProcess();
  const [role, target] = process.argv.slice(2);
  const run = { 'verify-customer': verifyCustomer, pharmacist, pharmacy, driver, statement, reconciliation }[role as 'verify-customer' | 'pharmacist' | 'pharmacy' | 'driver' | 'statement' | 'reconciliation'];
  if (!run || !target) {
    console.error('Usage: npm run staging:actors -- verify-customer <e-mail> | pharmacist <customer e-mail> | pharmacy <order number> | driver <order number> | statement now | reconciliation all');
    process.exitCode = EXIT_USAGE;
    return;
  }
  const app = await createStagingContext();
  try {
    await run(app, target, (line) => console.log(line));
  } finally {
    await app.close();
  }
}

if (require.main === module) {
  main().catch((err: unknown) => {
    if (err instanceof StagingRefusedError) {
      console.error(`Refused: ${err.message}`);
      process.exitCode = EXIT_REFUSED;
      return;
    }
    console.error(`staging:actors failed: ${err instanceof Error ? err.message : 'unknown error'}`);
    process.exitCode = 1;
  });
}
