import { AccessOutcome, PrescriptionAccessType, PrescriptionStatus } from '../enums';

export const PRESCRIPTION_REPOSITORY = Symbol('PRESCRIPTION_REPOSITORY');

/** Prescription aggregate root row (module-05 §3.1). */
export interface PrescriptionSnapshot {
  id: string;
  customerUserId: string;
  beneficiaryId: string | null;
  status: PrescriptionStatus;
  fileRef: string | null;
  encryptionKeyRef: string | null;
  fileType: string | null;
  doctorName: string | null;
  hospitalName: string | null;
  issueDate: Date | null;
  expiryDate: Date | null;
  verifiedByUserId: string | null;
  verifiedAt: Date | null;
  verifyingPharmacyId: string | null;
  rejectionReason: string | null;
  retentionUntil: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Data required to create a brand-new Prescription (`UploadPrescriptionCommand`, §5.1, §12). */
export interface NewPrescriptionData {
  customerUserId: string;
  beneficiaryId?: string | null;
  fileRef?: string | null;
  encryptionKeyRef?: string | null;
  fileType?: string | null;
  doctorName?: string | null;
  hospitalName?: string | null;
  issueDate?: Date | null;
  expiryDate?: Date | null;
  retentionUntil?: Date | null;
}

/**
 * Header fields written by a status transition — verification decisions (§10.2), re-upload
 * (§10.1), and `AssignVerifyingPharmacyCommand` (§4, §20 Decision 6). The caller has already
 * validated the transition itself via `PrescriptionStatusPolicy` before calling this; this
 * contract only persists the already-decided next state and whichever fields that decision sets.
 */
export interface PrescriptionStatusUpdate {
  status: PrescriptionStatus;
  verifiedByUserId?: string | null;
  verifiedAt?: Date | null;
  verifyingPharmacyId?: string | null;
  rejectionReason?: string | null;
  fileRef?: string | null;
  encryptionKeyRef?: string | null;
  fileType?: string | null;
}

/**
 * Child `PrescriptionLine` row of the Prescription aggregate (module-05 §3.2). `prescribedQuantity`
 * is the schema column (`prisma/schema/05-prescription.prisma`) backing what §5.2's
 * `ApproveLineDto` calls `approvedQuantity` once a line has been mapped at approval — `null`
 * before approval, since lines do not exist until `ApprovePrescriptionCommand` creates them
 * (§12 "Approve prescription": "`PrescriptionLine` inserts (one per approved line...)").
 */
export interface PrescriptionLineSnapshot {
  id: string;
  prescriptionId: string;
  catalogProductId: string | null;
  rawText: string | null;
  prescribedQuantity: number | null;
  refillsAllowed: number;
  dispensedQuantity: number;
  remainingDispensable: number;
  isSingleUse: boolean;
  createdAt: Date;
}

/** One approved line to insert at `ApprovePrescriptionCommand` time (§5.2, §12). `remainingDispensable` starts equal to `prescribedQuantity` (§3.2). */
export interface NewPrescriptionLineData {
  catalogProductId: string;
  rawText?: string | null;
  prescribedQuantity: number;
  refillsAllowed: number;
  isSingleUse: boolean;
}

export interface ListPrescriptionsCriteria {
  customerUserId: string;
  status?: PrescriptionStatus;
  page: number;
  size: number;
}

export interface VerificationQueueCriteria {
  verifyingPharmacyId: string;
  page: number;
  size: number;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
}

/** One `PrescriptionAccessLog` entry (module-05 §3.5, FR-REC-06) — written for every `GET /prescriptions/:id`, allow or deny. */
export interface NewPrescriptionAccessLogEntry {
  prescriptionId: string;
  actorUserId: string;
  role: string | null;
  accessType: PrescriptionAccessType;
  outcome: AccessOutcome;
}

/**
 * Persistence port for the Prescription aggregate (module-05 §3.1/§3.2, §11) — the Prescription
 * header plus its child `PrescriptionLine` rows. There is deliberately no separate
 * `IPrescriptionLineRepository`: the module's own file layout (§11) names exactly
 * `IPrescriptionRepository`, `IVerificationRepository`, `IDispenseLedgerRepository`,
 * `IMatchRepository` — `PrescriptionLine` is a child entity of the Prescription aggregate, not
 * an aggregate root of its own.
 *
 * Every mutating method accepts an optional `tx` handle (the opaque type `IUnitOfWork.run`
 * passes through) so callers can compose multiple repository calls inside one `Serializable`
 * transaction (§2.1.1, §12) — e.g. `updateStatus` + `createApprovedLines` inside the same
 * "Approve prescription" atomic unit. The domain/application layer depends on this interface; a
 * future Prisma adapter implements it in the infrastructure layer (not built by this task).
 */
export interface IPrescriptionRepository {
  findById(id: string, tx?: unknown): Promise<PrescriptionSnapshot | null>;
  create(data: NewPrescriptionData, tx?: unknown): Promise<PrescriptionSnapshot>;
  updateStatus(id: string, update: PrescriptionStatusUpdate, tx?: unknown): Promise<void>;
  listByCustomer(criteria: ListPrescriptionsCriteria): Promise<PagedResult<PrescriptionSnapshot>>;
  listVerificationQueue(
    criteria: VerificationQueueCriteria,
  ): Promise<PagedResult<PrescriptionSnapshot>>;

  findLineById(lineId: string, tx?: unknown): Promise<PrescriptionLineSnapshot | null>;
  findLinesByPrescriptionId(
    prescriptionId: string,
    tx?: unknown,
  ): Promise<PrescriptionLineSnapshot[]>;
  /** Inserts the approved lines (§12 "Approve prescription"). Called once, at approval time, never re-called for an already-approved prescription. */
  createApprovedLines(
    prescriptionId: string,
    lines: NewPrescriptionLineData[],
    tx?: unknown,
  ): Promise<PrescriptionLineSnapshot[]>;
  /**
   * Persists the recomputed `dispensedQuantity`/`remainingDispensable` for one line (§3.11
   * invariant 3, §8.1 step 6) — the derived-cache values themselves are computed by the caller
   * from a fresh in-transaction read plus the `DispenseRecord` about to be inserted; this method
   * never independently mutates them (ADR-006, mirrors Module 04's `sellable` cache discipline).
   */
  updateLineDispenseState(
    lineId: string,
    dispensedQuantity: number,
    remainingDispensable: number,
    tx?: unknown,
  ): Promise<void>;

  /** Appends one `PrescriptionAccessLog` row (allow or deny, FR-REC-06) — independent of the hash-chained `audit_logs` (§3.5). */
  logAccess(entry: NewPrescriptionAccessLogEntry, tx?: unknown): Promise<void>;
}
