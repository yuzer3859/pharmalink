/**
 * Re-exported Prisma enums (module-05 §3.8), same pattern as Modules 02/03/04's own
 * `domain/enums.ts` — the domain layer depends on the enum shape, not on `@prisma/client` as a
 * whole.
 */
export {
  PrescriptionStatus,
  VerificationDecision,
  PrescriptionAccessType,
  AccessOutcome,
  MatchStatus,
  MatchStrategy,
  MatchCoverage,
} from '@prisma/client';
