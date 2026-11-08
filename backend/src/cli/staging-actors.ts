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
import { DeliveryJobStatus, PodType } from '../modules/delivery/domain/enums';
import { userVerifiedEvent } from '../modules/identity/domain/events';
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
 *   npm run staging:actors -- driver <order number>          accept the job, pick up, deliver with proof
 *
 * Events these commands write are relayed by the running staging backend (capture at ready, the
 * delivery job and its dispatch, the order following its delivery).
 */

const EXIT_REFUSED = 2;
const EXIT_USAGE = 64;
const WALK_PHARMACY = FIXTURE_ORGANIZATIONS.find((o) => o.key === 'transacting')!;
const WALK_DRIVER_PHONE = FIXTURE_ACCOUNTS.find((a) => a.key === 'driverCod')!.phone!;

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
 * registered customer's e-mail verified, as the code would have: only a CUSTOMER account still
 * PENDING_VERIFICATION with no roles, through the domain (`markEmailVerified`), with the same
 * `identity.user.verified` event, and audited. Staging only, like every actor here.
 */
export async function verifyCustomer(app: INestApplicationContext, email: string, log: Log): Promise<void> {
  const prisma = app.get(PrismaService);
  const row = await prisma.user.findFirst({ where: { email: email.toLowerCase() }, include: { userRoles: true } });
  if (!row) throw new Error(`No account ${email}. Sign up in the customer app first.`);
  if (row.primaryRole !== 'CUSTOMER' || row.userRoles.length > 0) throw new Error(`${email} is not a customer account; only customers can be verified this way.`);
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
  const user = await prisma.user.findFirstOrThrow({ where: { phone: WALK_DRIVER_PHONE } });
  const started = Date.now();
  let job = await prisma.deliveryJob.findFirst({ where: { orderId: order.id } });
  while (!job && Date.now() - started < waitMs) {
    await new Promise((r) => setTimeout(r, 2_000));
    job = await prisma.deliveryJob.findFirst({ where: { orderId: order.id } });
  }
  if (!job) throw new Error('No delivery job yet: is the order ready, and is the staging backend running?');
  if (job.status === DeliveryJobStatus.CREATED || job.status === DeliveryJobStatus.REASSIGNING) {
    await app.get(DispatchDeliveryJobCommand).execute({ jobId: job.id, actorUserId: null });
  }
  if ((await prisma.deliveryJob.findUniqueOrThrow({ where: { id: job.id } })).status === DeliveryJobStatus.OFFERED) {
    await app.get(AcceptJobOfferCommand).execute({ userId: user.id, jobId: job.id });
  }
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

async function main(): Promise<void> {
  declareCliProcess();
  const [role, target] = process.argv.slice(2);
  const run = { 'verify-customer': verifyCustomer, pharmacist, pharmacy, driver }[role as 'verify-customer' | 'pharmacist' | 'pharmacy' | 'driver'];
  if (!run || !target) {
    console.error('Usage: npm run staging:actors -- verify-customer <e-mail> | pharmacist <customer e-mail> | pharmacy <order number> | driver <order number>');
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
