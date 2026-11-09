import { UpdateProductCommand } from '../../modules/catalog/application/commands/update-product.command';
import { CreateListingCommand } from '../../modules/pharmacy-inventory/application/commands/create-listing.command';
import { INestApplicationContext } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { AuditService } from '../../shared/audit/audit.service';
import { DOCUMENT_STORAGE_PORT, IDocumentStoragePort } from '../../shared/storage/document-storage.port';
import { seedSampleDocument } from './sample-document';
import { ApproveCatalogProductCommand } from '../../modules/admin/application/commands/approve-catalog-product.command';
import { ApproveVerificationCommand } from '../../modules/admin/application/commands/approve-verification.command';
import { RejectCatalogProductCommand } from '../../modules/admin/application/commands/reject-catalog-product.command';
import { RejectVerificationCommand } from '../../modules/admin/application/commands/reject-verification.command';
import { SubmitCatalogProductCommand } from '../../modules/admin/application/commands/submit-catalog-product.command';
import { ToggleFeatureFlagCommand } from '../../modules/admin/application/commands/toggle-feature-flag.command';
import { ChangeProductStatusCommand } from '../../modules/catalog/application/commands/change-product-status.command';
import { CreateManufacturerCommand } from '../../modules/catalog/application/commands/create-manufacturer.command';
import { CreateProductCommand } from '../../modules/catalog/application/commands/create-product.command';
import { AcceptJobOfferCommand } from '../../modules/delivery/application/commands/accept-job-offer.command';
import { AdvanceDeliveryJobCommand } from '../../modules/delivery/application/commands/advance-delivery-job.command';
import { CreateDeliveryJobCommand } from '../../modules/delivery/application/commands/create-delivery-job.command';
import { CreateDriverProfileCommand } from '../../modules/delivery/application/commands/create-driver-profile.command';
import { DispatchDeliveryJobCommand } from '../../modules/delivery/application/commands/dispatch-delivery-job.command';
import { ManageCodDisputeCommand } from '../../modules/delivery/application/commands/manage-cod-dispute.command';
import { ManageDriverShiftCommand } from '../../modules/delivery/application/commands/manage-driver-shift.command';
import { RecordCodCollectionCommand } from '../../modules/delivery/application/commands/record-cod-collection.command';
import { SetDriverAvailabilityCommand } from '../../modules/delivery/application/commands/set-driver-availability.command';
import { CodCollectionMethod, DeliveryJobStatus, DriverAvailability } from '../../modules/delivery/domain/enums';
import { VehicleType } from '../../modules/delivery/domain/value-objects/vehicle.vo';
import { ApplyPharmacyOrganizationCommand } from '../../modules/identity/application/commands/apply-pharmacy-organization.command';
import { SubmitFaydaVerificationCommand } from '../../modules/identity/application/commands/submit-fayda-verification.command';
import { SubmitVerificationDocumentsCommand } from '../../modules/identity/application/commands/submit-verification-documents.command';
import { AccountStatus, PreferredLanguage, PrimaryRole, VerificationType } from '../../modules/identity/domain/enums';
import { IUserRepository, USER_REPOSITORY } from '../../modules/identity/domain/repositories/user.repository';
import { AuthorizePaymentCommand } from '../../modules/payment/application/commands/authorize-payment.command';
import { CapturePaymentCommand } from '../../modules/payment/application/commands/capture-payment.command';
import { RefundInitiator, RefundPaymentCommand } from '../../modules/payment/application/commands/refund-payment.command';
import { RunSettlementCommand } from '../../modules/payment/application/commands/run-settlement.command';
import { PaymentMethod } from '../../modules/payment/domain/enums';
import { ActivatePharmacyCommand } from '../../modules/pharmacy-inventory/application/commands/activate-pharmacy.command';
import { CreateBranchCommand } from '../../modules/pharmacy-inventory/application/commands/create-branch.command';
import { RegisterPharmacyCommand } from '../../modules/pharmacy-inventory/application/commands/register-pharmacy.command';
import {
  FIXTURE_ACCOUNTS,
  FIXTURE_DISPUTE_REASON,
  FIXTURE_FAYDA_ID,
  FIXTURE_FEATURE_FLAG,
  FIXTURE_MANUFACTURER,
  FIXTURE_ORDERS,
  FIXTURE_ORGANIZATIONS,
  FIXTURE_PRODUCTS,
  WALK_ROUNDS,
  FixtureOrder,
  FixtureOrganization,
  FixtureProduct,
} from './fixtures';

/** How far ahead an approved seed licence expires. */
const LICENCE_VALIDITY_MS = 365 * 24 * 60 * 60 * 1000;
/** Settlement window for the seeded statement: the last 30 days up to the run. */
const SETTLEMENT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const SEED_KEY = 'staging-seed-v1';
/** The finance permission a manual refund needs (checked inside the command, not only at HTTP). */
const REFUND_PERMISSION = 'finance:refund:any';

export type SeedLog = (line: string) => void;

export interface SeedSummary {
  created: string[];
  existing: string[];
}

/**
 * Builds the staging verification baseline (Work 80) through the application's own commands, so
 * every audit entry, outbox event, status history and invariant is what production would write.
 * Direct writes are limited to what no command produces, each marked where it happens:
 *  - fixture users (no OTP round-trip) and their role grants, as the e2e fixtures do;
 *  - order rows (checkout needs a cart, stock and reservations the admin pages never show);
 *  - the SUSPENDED organisation (no backend action suspends an organisation yet).
 *
 * Idempotent: each step looks for what it would create by a stable natural key (e-mail, phone,
 * legal name, product name, order number, idempotency key) and skips it when present, so a second
 * run changes nothing. The run is not a transaction: if a step fails, rerunning resumes it.
 */
export class StagingSeeder {
  private readonly prisma: PrismaService;
  private readonly summary: SeedSummary = { created: [], existing: [] };
  private readonly accounts = new Map<string, string>();
  private readonly orgs = new Map<string, { organizationId: string; pharmacyId: string | null; branchId: string | null }>();
  private readonly products = new Map<string, string>();

  constructor(
    private readonly app: INestApplicationContext,
    private readonly log: SeedLog,
  ) {
    this.prisma = app.get(PrismaService);
  }

  async run(): Promise<SeedSummary> {
    for (const account of FIXTURE_ACCOUNTS) await this.ensureAccount(account);
    for (const org of FIXTURE_ORGANIZATIONS) await this.ensureOrganization(org);
    await this.ensurePendingPersonVerifications();
    await this.ensurePreviewVerification();
    await this.ensureDriverReady('driverCod', 'AA-3-STG80');
    await this.ensureDriverReady('driverWalkSpare', 'AA-3-STG81');
    for (const product of FIXTURE_PRODUCTS) await this.ensureProduct(product);
    await this.ensureMarketplace();
    for (const order of FIXTURE_ORDERS) await this.ensureOrder(order);
    await this.ensureSettlement();
    await this.ensureFeatureFlag();
    return this.summary;
  }

  // ---------------------------------------------------------------------------------------------
  // Accounts
  // ---------------------------------------------------------------------------------------------

  private async ensureAccount(account: (typeof FIXTURE_ACCOUNTS)[number]): Promise<void> {
    const users = this.app.get<IUserRepository>(USER_REPOSITORY);
    const byEmail = account.email ? await users.findByEmail(account.email) : null;
    const found = byEmail ?? (account.phone ? await users.findByPhone(account.phone) : null);
    if (found) {
      // Work 117: a fixture seeded before it had an e-mail (the walk drivers) gets it now, verified,
      // so the person can sign in by e-mail; the account is otherwise left as it is.
      if (account.email && !byEmail) {
        await this.prisma.user.update({ where: { id: found.id }, data: { email: account.email, emailVerifiedAt: new Date() } });
        await this.audit('staging.seed.account_email_added', 'user', found.id, { fixture: account.key });
        this.note(true, `e-mail for account ${account.key}`);
      } else {
        this.note(false, `account ${account.key}`);
      }
      this.accounts.set(account.key, found.id);
      return;
    }
    // Direct creation, as the e2e fixtures do: registration would need an OTP round-trip per
    // fixture. Status ACTIVE and the contact marked verified, with no password.
    const user = await users.create({
      phone: account.phone,
      email: account.email,
      passwordHash: null,
      primaryRole: account.primaryRole as PrimaryRole,
      status: AccountStatus.ACTIVE,
      preferredLanguage: PreferredLanguage.en,
    });
    if (account.email) user.markEmailVerified();
    if (account.phone) user.markPhoneVerified();
    await users.save(user);
    if (account.roleKey) {
      const role = await this.prisma.role.findUniqueOrThrow({ where: { key: account.roleKey } });
      await this.prisma.userRole.create({ data: { userId: user.id, roleId: role.id, organizationId: null } });
    }
    await this.audit('staging.seed.account_created', 'user', user.id, { fixture: account.key, roleKey: account.roleKey });
    this.accounts.set(account.key, user.id);
    this.note(true, `account ${account.key}`);
  }

  /** Pharmacy owners: active customers with a verified e-mail, the precondition of an application. */
  private async ensureOwner(ownerEmail: string): Promise<string> {
    const users = this.app.get<IUserRepository>(USER_REPOSITORY);
    const found = await users.findByEmail(ownerEmail);
    if (found) return found.id;
    const user = await users.create({
      phone: null,
      email: ownerEmail,
      passwordHash: null,
      primaryRole: PrimaryRole.CUSTOMER,
      status: AccountStatus.ACTIVE,
      preferredLanguage: PreferredLanguage.en,
    });
    user.markEmailVerified();
    await users.save(user);
    await this.audit('staging.seed.account_created', 'user', user.id, { fixture: 'pharmacy-owner' });
    return user.id;
  }

  private account(key: string): string {
    const id = this.accounts.get(key);
    if (!id) throw new Error(`Fixture account ${key} was not created.`);
    return id;
  }

  // ---------------------------------------------------------------------------------------------
  // Organisations and pharmacies
  // ---------------------------------------------------------------------------------------------

  private async ensureOrganization(fixture: FixtureOrganization): Promise<void> {
    const operator = this.account('operator');
    const ownerId = await this.ensureOwner(fixture.ownerEmail);
    const idempotencyKey = `${SEED_KEY}:org:${fixture.key}`;

    const existing = await this.prisma.organization.findFirst({ where: { ownerUserId: ownerId, applicationKey: idempotencyKey } });
    const created = !existing;
    const application = await this.app
      .get(ApplyPharmacyOrganizationCommand)
      .execute({ actorUserId: ownerId, legalName: fixture.legalName, idempotencyKey });
    const organizationId = application.organizationId;

    // Licence submission: one pending PHARMACY_LICENSE request per organisation, unless decided.
    const licence = await this.prisma.verificationRequest.findFirst({
      where: { organizationId, type: 'PHARMACY_LICENSE' },
      orderBy: { submittedAt: 'desc' },
    });
    let requestId = licence?.id ?? null;
    if (!licence) {
      const submitted = await this.app.get(SubmitVerificationDocumentsCommand).execute({
        userId: ownerId,
        type: VerificationType.PHARMACY_LICENSE,
        organizationId,
        documents: [
          { kind: 'BUSINESS_LICENSE', storageRef: await this.sampleDoc(ownerId, 'BUSINESS_LICENSE', `staging-seed/${fixture.key}/business-license.pdf`) },
          {
            kind: 'PHARMACIST_CERTIFICATE',
            storageRef: await this.sampleDoc(ownerId, 'PHARMACIST_CERTIFICATE', `staging-seed/${fixture.key}/pharmacist-certificate.pdf`),
          },
        ],
      });
      requestId = submitted.requestId;
    }

    const wantsApproved = fixture.licenseNumber !== null;
    if (licence?.status === 'PENDING' || !licence) {
      if (wantsApproved) {
        await this.app.get(ApproveVerificationCommand).execute({
          actorUserId: operator,
          requestId: requestId!,
          expiresAt: new Date(Date.now() + LICENCE_VALIDITY_MS),
          licenseNumber: fixture.licenseNumber,
          reason: 'Staging seed: licence documents checked.',
          ip: null,
        });
      } else if (fixture.outcome === 'REJECTED') {
        await this.app.get(RejectVerificationCommand).execute({
          actorUserId: operator,
          requestId: requestId!,
          reason: 'Staging seed: the licence number does not match the certificate.',
          ip: null,
        });
      }
    }

    let pharmacyId: string | null = null;
    let branchId: string | null = null;
    if (fixture.branch) {
      const registered =
        (await this.prisma.pharmacy.findUnique({ where: { organizationId } }))?.id ??
        (
          await this.app.get(RegisterPharmacyCommand).execute({
            actorUserId: ownerId,
            organizationId,
            displayName: fixture.legalName,
            description: `Staging fixture: ${fixture.purpose}`,
          })
        ).pharmacyId;
      pharmacyId = registered;
      branchId =
        (await this.prisma.branch.findFirst({ where: { pharmacyId: registered, name: fixture.branch.name } }))?.id ??
        (await this.app.get(CreateBranchCommand).execute({ pharmacyId: registered, region: 'Addis Ababa', ...fixture.branch }))
          .branchId;
      if (fixture.outcome === 'ACTIVE_TRANSACTING') {
        const current = await this.prisma.pharmacy.findUniqueOrThrow({ where: { id: registered } });
        if (current.transactingStatus !== 'ACTIVE') {
          await this.app.get(ActivatePharmacyCommand).execute({ actorUserId: operator, pharmacyId: registered });
        }
      }
    }

    if (fixture.outcome === 'SUSPENDED') {
      // Fixture data only: no backend action suspends an organisation yet (see the status doc).
      const org = await this.prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
      if (org.status !== 'SUSPENDED') {
        await this.prisma.organization.update({ where: { id: organizationId }, data: { status: 'SUSPENDED' } });
        await this.audit('staging.seed.organization_suspended', 'organization', organizationId, {
          note: 'Fixture state written directly; no suspend action exists in the backend.',
        });
      }
    }

    this.orgs.set(fixture.key, { organizationId, pharmacyId, branchId });
    this.note(created, `organisation ${fixture.key}`);
  }

  // ---------------------------------------------------------------------------------------------
  // Pending verifications of every person-level type
  // ---------------------------------------------------------------------------------------------

  /** One pending FAYDA, DRIVER_DOCS and DOCTOR_LICENSE request per walk round. */
  private async ensurePendingPersonVerifications(): Promise<void> {
    for (const round of WALK_ROUNDS) {
      const suffix = round === 'admin' ? '' : 'SuperAdmin';
      const faydaUser = this.account(`customerFayda${suffix}`);
      if (!(await this.prisma.verificationRequest.findFirst({ where: { userId: faydaUser, type: 'FAYDA' } }))) {
        await this.app.get(SubmitFaydaVerificationCommand).execute({
          userId: faydaUser,
          // The mock provider accepts any 12-digit number; one per round keeps them distinct.
          faydaId: round === 'admin' ? FIXTURE_FAYDA_ID : FIXTURE_FAYDA_ID.replace(/0$/, '1'),
          consentGranted: true,
          fullName: `Seed Fayda Customer (${round})`,
        });
        this.note(true, `verification FAYDA (${round})`);
      } else this.note(false, `verification FAYDA (${round})`);

      for (const [base, type, kinds] of [
        ['driverPending', VerificationType.DRIVER_DOCS, ['DRIVING_LICENSE', 'VEHICLE_REGISTRATION']],
        ['doctorPending', VerificationType.DOCTOR_LICENSE, ['MEDICAL_LICENSE']],
      ] as const) {
        const key = `${base}${suffix}`;
        const userId = this.account(key);
        if (await this.prisma.verificationRequest.findFirst({ where: { userId, type } })) {
          this.note(false, `verification ${type} (${round})`);
          continue;
        }
        await this.app.get(SubmitVerificationDocumentsCommand).execute({
          userId,
          type,
          documents: await Promise.all(
            kinds.map(async (kind) => ({ kind, storageRef: await this.sampleDoc(userId, kind, `staging-seed/${key}/${kind.toLowerCase()}.pdf`) })),
          ),
        });
        this.note(true, `verification ${type} (${round})`);
      }
    }
  }

  /**
   * Work 92: one pending DRIVER_DOCS request whose documents are stored, so the document preview
   * can be opened on a stack whose earlier requests were all decided. Left pending by the walk.
   */
  private async ensurePreviewVerification(): Promise<void> {
    const userId = this.account('driverPreview');
    const type = VerificationType.DRIVER_DOCS;
    if (await this.prisma.verificationRequest.findFirst({ where: { userId, type } })) {
      this.note(false, 'verification DRIVER_DOCS (document preview)');
      return;
    }
    await this.app.get(SubmitVerificationDocumentsCommand).execute({
      userId,
      type,
      documents: await Promise.all(
        ['DRIVING_LICENSE', 'VEHICLE_REGISTRATION'].map(async (kind) => ({
          kind,
          storageRef: await this.sampleDoc(userId, kind, `staging-seed/driverPreview/${kind.toLowerCase()}.pdf`),
        })),
      ),
    });
    this.note(true, 'verification DRIVER_DOCS (document preview)');
  }

  /** Work 89: a stored sample PDF (previewable in the review), or the old text reference without storage. */
  private sampleDoc(ownerId: string, kind: string, fallbackRef: string): Promise<string> {
    let storage: IDocumentStoragePort | null = null;
    try {
      storage = this.app.get<IDocumentStoragePort>(DOCUMENT_STORAGE_PORT, { strict: false });
    } catch {
      storage = null;
    }
    return seedSampleDocument(storage, ownerId, kind.replace(/_/g, ' ').toLowerCase(), fallbackRef);
  }

  /** An approved driver (the COD driver, Work 105's spare): documents approved by the operator, a profile. */
  private async ensureDriverReady(key: 'driverCod' | 'driverWalkSpare', plateNumber: string): Promise<void> {
    const driver = this.account(key);
    const operator = this.account('operator');
    let docs = await this.prisma.verificationRequest.findFirst({ where: { userId: driver, type: 'DRIVER_DOCS' } });
    if (!docs) {
      const submitted = await this.app.get(SubmitVerificationDocumentsCommand).execute({
        userId: driver,
        type: VerificationType.DRIVER_DOCS,
        documents: [
          { kind: 'DRIVING_LICENSE', storageRef: await this.sampleDoc(driver, 'DRIVING_LICENSE', `staging-seed/${key}/driving_license.pdf`) },
          {
            kind: 'VEHICLE_REGISTRATION',
            storageRef: await this.sampleDoc(driver, 'VEHICLE_REGISTRATION', `staging-seed/${key}/vehicle_registration.pdf`),
          },
        ],
      });
      docs = await this.prisma.verificationRequest.findUniqueOrThrow({ where: { id: submitted.requestId } });
    }
    if (docs.status === 'PENDING') {
      await this.app.get(ApproveVerificationCommand).execute({
        actorUserId: operator,
        requestId: docs.id,
        expiresAt: new Date(Date.now() + LICENCE_VALIDITY_MS),
        reason: 'Staging seed: driver documents checked.',
        ip: null,
      });
    }
    const branch = FIXTURE_ORGANIZATIONS.find((o) => o.key === 'transacting')!.branch!;
    const profile = await this.prisma.driverProfile.findUnique({ where: { userId: driver } });
    if (!profile) {
      await this.app.get(CreateDriverProfileCommand).execute({
        userId: driver,
        vehicleType: VehicleType.Motorcycle,
        plateNumber,
        serviceArea: { lat: branch.lat, lng: branch.lng, radiusMeters: 20_000 },
        // Both COD jobs stay open at the drop-off (the collection is recorded there), so one
        // driver must be allowed more than one job at a time.
        maxConcurrent: 5,
        actorUserId: operator,
      });
      this.note(true, `driver profile (${key})`);
    } else this.note(false, `driver profile (${key})`);
  }

  private async driverOnline(online: boolean): Promise<void> {
    const userId = this.account('driverCod');
    if (online) {
      try {
        await this.app.get(ManageDriverShiftCommand).start({ userId });
      } catch (err) {
        // Already on shift from an earlier run.
        if (!/shift/i.test(err instanceof Error ? err.message : '')) throw err;
      }
    }
    await this.app
      .get(SetDriverAvailabilityCommand)
      .execute({ userId, availability: online ? DriverAvailability.ONLINE : DriverAvailability.OFFLINE });
  }

  // ---------------------------------------------------------------------------------------------
  // Catalogue
  // ---------------------------------------------------------------------------------------------

  /** MEDICINE products must name a manufacturer (module-03 §3.6 invariant 8). */
  private async ensureManufacturer(): Promise<string> {
    const found = await this.prisma.manufacturer.findFirst({ where: { name: FIXTURE_MANUFACTURER } });
    if (found) return found.id;
    const created = await this.app
      .get(CreateManufacturerCommand)
      .execute({ actorUserId: this.account('operator'), name: FIXTURE_MANUFACTURER, country: 'ET' });
    this.note(true, 'manufacturer');
    return created.id;
  }

  private async ensureProduct(fixture: FixtureProduct): Promise<void> {
    const operator = this.account('operator');
    const existing = await this.prisma.product.findFirst({ where: { nameEn: fixture.nameEn } });
    const productId =
      existing?.id ??
      (
        await this.app.get(CreateProductCommand).execute({
          actorUserId: operator,
          type: 'MEDICINE',
          manufacturerId: await this.ensureManufacturer(),
          nameEn: fixture.nameEn,
          genericName: fixture.genericName,
          dosageForm: fixture.dosageForm,
          strengthValue: fixture.strength.value,
          strengthUnit: fixture.strength.unit,
          packSize: '10',
          rxClassification: fixture.key === 'active' || fixture.key === 'delisted' ? 'RX' : 'OTC',
          controlledSchedule: fixture.key === 'delisted' ? 'SCHEDULE_2' : 'NONE',
          descriptionEn: `Staging fixture: ${fixture.purpose}`,
        })
      ).id;
    this.products.set(fixture.key, productId);

    const status = async () => (await this.prisma.product.findUniqueOrThrow({ where: { id: productId } })).status;
    if (fixture.outcome !== 'DRAFT' && (await status()) === 'DRAFT') {
      await this.app.get(SubmitCatalogProductCommand).execute({ actorUserId: operator, productId });
    }
    if (['ACTIVE', 'DEPRECATED', 'DELISTED'].includes(fixture.outcome) && (await status()) === 'PENDING_REVIEW') {
      await this.app.get(ApproveCatalogProductCommand).execute({ actorUserId: operator, productId });
    }
    if (fixture.outcome === 'REJECTED' && (await status()) === 'PENDING_REVIEW') {
      await this.app.get(RejectCatalogProductCommand).execute({
        actorUserId: operator,
        productId,
        reason: 'Staging seed: strength missing from the label image.',
      });
    }
    if ((fixture.outcome === 'DEPRECATED' || fixture.outcome === 'DELISTED') && (await status()) === 'ACTIVE') {
      await this.app.get(ChangeProductStatusCommand).execute({
        actorUserId: operator,
        productId,
        status: fixture.outcome,
        reason: `Staging seed: ${fixture.purpose}.`,
      });
    }
    this.note(!existing, `product ${fixture.key}`);
  }

  /**
   * Work 103: what a customer can buy in the Phase 1 walk. Seed Bole Pharmacy (transacting) stocks
   * the OTC walk product and the Rx Amoxicillin at Bole Main, both with a catalogue price, and its
   * owner also holds PHARMACIST there, so `npm run staging:actors -- pharmacist` can review a
   * prescription for that pharmacy. Idempotent.
   */
  private async ensureMarketplace(): Promise<void> {
    const org = this.orgs.get('transacting');
    if (!org?.pharmacyId || !org.branchId) return;
    const operator = this.account('operator');
    const ownerId = (await this.prisma.organization.findUniqueOrThrow({ where: { id: org.organizationId } })).ownerUserId;

    const role = await this.prisma.role.findUniqueOrThrow({ where: { key: 'PHARMACIST' } });
    const hasRole = await this.prisma.userRole.findFirst({ where: { userId: ownerId, roleId: role.id, organizationId: org.organizationId } });
    if (!hasRole) {
      await this.prisma.userRole.create({ data: { userId: ownerId, roleId: role.id, organizationId: org.organizationId } });
      await this.audit('staging.seed.role_granted', 'user', ownerId, { roleKey: 'PHARMACIST', organizationId: org.organizationId });
    }
    this.note(!hasRole, 'pharmacist role at Seed Bole Pharmacy');

    for (const [key, price] of [['walkOtc', 1_200], ['active', 4_500]] as const) {
      const productId = this.products.get(key);
      if (!productId) continue;
      const product = await this.prisma.product.findUniqueOrThrow({ where: { id: productId } });
      if (product.price === null) {
        await this.app.get(UpdateProductCommand).execute({ actorUserId: operator, productId, price });
      }
      const listing = await this.prisma.inventoryListing.findFirst({ where: { branchId: org.branchId, catalogProductId: productId } });
      if (!listing) {
        await this.app.get(CreateListingCommand).execute({
          actorUserId: ownerId,
          pharmacyId: org.pharmacyId,
          branchId: org.branchId,
          catalogProductId: productId,
          price,
          batchNumber: `STG-WALK-${key}`,
          initialQuantity: 200,
          expiryDate: '2028-12-31',
        });
      }
      this.note(!listing, `stock ${key} at Bole Main`);
    }
  }

  // ---------------------------------------------------------------------------------------------
  // Orders, payments, refunds, COD
  // ---------------------------------------------------------------------------------------------

  private async ensureOrder(fixture: FixtureOrder): Promise<void> {
    const { pharmacyId, branchId } = this.orgs.get('transacting')!;
    const customer = this.account('customerOrders');
    const productId = this.products.get('active')!;
    const product = FIXTURE_PRODUCTS.find((p) => p.key === 'active')!;

    let order = await this.prisma.order.findUnique({ where: { orderNumber: fixture.orderNumber } });
    const created = !order;
    if (!order) {
      // Direct order rows, as the e2e fixtures do: a real checkout needs a cart, stock and
      // reservations that the admin pages never show. Everything after this goes through commands.
      order = await this.prisma.order.create({
        data: {
          orderNumber: fixture.orderNumber,
          customerUserId: customer,
          status: fixture.isCod ? 'PAID' : 'PENDING_PAYMENT',
          subtotal: fixture.grandTotal,
          grandTotal: fixture.grandTotal,
          currency: 'ETB',
          isCod: fixture.isCod,
          placedAt: new Date(),
          idempotencyKey: `${SEED_KEY}:checkout:${fixture.key}`,
          addressSnapshot: { line1: 'Kazanchis, Building 4', city: 'Addis Ababa', lat: 9.0186, lng: 38.7742 },
        },
      });
      const fulfillment = await this.prisma.fulfillment.create({
        data: { orderId: order.id, pharmacyId: pharmacyId!, branchId: branchId!, status: fixture.isCod ? 'READY' : 'PENDING' },
      });
      await this.prisma.orderLine.create({
        data: {
          orderId: order.id,
          fulfillmentId: fulfillment.id,
          pharmacyId,
          branchId,
          catalogProductId: productId,
          productSnapshot: { name: product.nameEn, genericName: product.genericName },
          quantity: 1,
          unitPrice: fixture.grandTotal,
          lineTotal: fixture.grandTotal,
        },
      });
      await this.audit('staging.seed.order_created', 'order', order.id, { fixture: fixture.key, orderNumber: fixture.orderNumber });
    }

    if (fixture.isCod) await this.ensureCod(fixture, order.id);
    else await this.ensurePayment(fixture, order.id, customer);
    this.note(created, `order ${fixture.key}`);
  }

  private async ensurePayment(fixture: FixtureOrder, orderId: string, customerUserId: string): Promise<void> {
    const finance = this.account('finance');
    // Replays on every run after the first: the idempotency key returns the original payment.
    const authorized = await this.app.get(AuthorizePaymentCommand).execute({
      customerUserId,
      orderId,
      method: PaymentMethod.TELEBIRR,
      idempotencyKey: `${SEED_KEY}:pay:${fixture.key}`,
    });
    const payment = await this.prisma.payment.findUniqueOrThrow({ where: { id: authorized.paymentId } });
    if (fixture.capture && payment.status === 'AUTHORIZED') {
      await this.app.get(CapturePaymentCommand).execute({ paymentId: payment.id, actorUserId: finance });
    }
    if (fixture.refund) {
      await this.app.get(RefundPaymentCommand).execute({
        paymentId: payment.id,
        amount: fixture.refund.amount,
        reason: fixture.refund.reason,
        idempotencyKey: `${SEED_KEY}:refund:${fixture.key}`,
        initiator: RefundInitiator.MANUAL,
        actorUserId: finance,
        actorPermissions: [REFUND_PERMISSION],
      });
    }
  }

  private async ensureCod(fixture: FixtureOrder, orderId: string): Promise<void> {
    const fulfillment = await this.prisma.fulfillment.findFirstOrThrow({ where: { orderId } });
    let jobId = fulfillment.deliveryJobId;
    if (!jobId) {
      const existingJob = await this.prisma.deliveryJob.findFirst({ where: { fulfillmentId: fulfillment.id } });
      jobId = existingJob?.id ?? (await this.app.get(CreateDeliveryJobCommand).execute({ fulfillmentId: fulfillment.id })).job.id;
    }
    const driver = this.account('driverCod');
    let job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    if (job.status === 'CREATED' || job.status === 'OFFERED') {
      await this.driverOnline(true);
      try {
        if (job.status === 'CREATED') {
          const dispatched = await this.app.get(DispatchDeliveryJobCommand).execute({ jobId, actorUserId: null });
          if (!dispatched.offer) {
            throw new Error(`Dispatch of the ${fixture.key} delivery found no eligible driver (${dispatched.outcome}).`);
          }
        }
        await this.app.get(AcceptJobOfferCommand).execute({ userId: driver, jobId });
      } finally {
        await this.driverOnline(false);
      }
      job = await this.prisma.deliveryJob.findUniqueOrThrow({ where: { id: jobId } });
    }
    const route = [
      DeliveryJobStatus.ARRIVED_PICKUP,
      DeliveryJobStatus.PICKED_UP,
      DeliveryJobStatus.EN_ROUTE,
      DeliveryJobStatus.ARRIVED_DROPOFF,
    ] as const;
    // From ASSIGNED the whole route remains; from a later stop, only what is left of it.
    const reached = (route as readonly string[]).indexOf(job.status);
    for (const to of route.slice(reached + 1)) {
      await this.app.get(AdvanceDeliveryJobCommand).byDriver({ userId: driver, jobId, to });
    }

    let collection = await this.prisma.codCollection.findFirst({ where: { jobId } });
    if (!collection) {
      const recorded = await this.app.get(RecordCodCollectionCommand).execute({
        userId: driver,
        jobId,
        collectedAmount: fixture.codCollected!,
        method: CodCollectionMethod.CASH,
      });
      collection = await this.prisma.codCollection.findUniqueOrThrow({ where: { id: recorded.collection.id } });
    }
    if (fixture.codCollected! < fixture.grandTotal) {
      const open = await this.prisma.codDispute.findFirst({ where: { collectionId: collection.id } });
      if (!open) {
        await this.app.get(ManageCodDisputeCommand).open({
          actorUserId: this.account('finance'),
          collectionId: collection.id,
          reason: FIXTURE_DISPUTE_REASON,
        });
      }
    }
  }

  private async ensureSettlement(): Promise<void> {
    const { pharmacyId } = this.orgs.get('transacting')!;
    if (await this.prisma.settlement.findFirst({ where: { pharmacyId: pharmacyId! } })) {
      this.note(false, 'settlement');
      return;
    }
    const periodEnd = new Date();
    await this.app.get(RunSettlementCommand).execute({
      pharmacyId: pharmacyId!,
      periodStart: new Date(periodEnd.getTime() - SETTLEMENT_WINDOW_MS),
      periodEnd,
      actorUserId: this.account('finance'),
    });
    this.note(true, 'settlement');
  }

  private async ensureFeatureFlag(): Promise<void> {
    if (await this.prisma.featureFlag.findUnique({ where: { key: FIXTURE_FEATURE_FLAG } })) {
      this.note(false, 'feature flag');
      return;
    }
    await this.app.get(ToggleFeatureFlagCommand).execute({
      actorUserId: this.account('operator'),
      key: FIXTURE_FEATURE_FLAG,
      enabled: false,
      description: 'Staging fixture: a flag the admin walk toggles. Controls nothing.',
    });
    this.note(true, 'feature flag');
  }

  // ---------------------------------------------------------------------------------------------

  private async audit(action: string, resourceType: string, resourceId: string, context: Record<string, unknown>) {
    await this.app.get(AuditService).record({
      actorUserId: this.accounts.get('operator') ?? null,
      action,
      resourceType,
      resourceId,
      context: { ...context, seed: SEED_KEY },
    });
  }

  private note(created: boolean, what: string): void {
    (created ? this.summary.created : this.summary.existing).push(what);
    this.log(`${created ? 'created ' : 'existing'}  ${what}`);
  }
}
