import { DeliveryJobStatus, PodType } from '../enums';

/**
 * How much proof a delivery needs before it may be marked `DELIVERED` (§3.3 F-STS-04, BR-DEL-06,
 * BRULE-29).
 *
 * Ordered from weakest to strongest, and the ordering is meaningful: a stronger requirement is
 * satisfied by stronger evidence, so `ARTIFACT` accepts a signature or a photo and `CONFIRMATION`
 * accepts any of the three.
 */
export enum PodRequirement {
  /** No proof is demanded. A driver may still capture some, and it is recorded if they do. */
  None = 'NONE',
  /** The recipient must attest they received the order. No file is needed. */
  Confirmation = 'CONFIRMATION',
  /** A signature or a photo must be captured and stored. */
  Artifact = 'ARTIFACT',
}

/** What the policy needs to know about a delivery. Deliberately the facts, not the aggregate. */
export interface PodPolicySubject {
  isColdChain: boolean;
  isCod: boolean;
}

/**
 * The configured rules, resolved from `delivery.pod*` and handed in.
 *
 * Passed as an argument rather than read here because this is a pure domain service: it decides,
 * it does not fetch. That is also what makes every rule below trivially testable at every setting
 * without a config module in the room.
 */
export interface PodPolicySettings {
  /** What every delivery requires. */
  base: PodRequirement;
  /** What a cold-chain delivery requires (BRULE-30), when that should be stricter. */
  coldChain: PodRequirement;
  /** What a cash-on-delivery delivery requires, when that should be stricter. */
  cod: PodRequirement;
}

const STRENGTH: Record<PodRequirement, number> = {
  [PodRequirement.None]: 0,
  [PodRequirement.Confirmation]: 1,
  [PodRequirement.Artifact]: 2,
};

/**
 * The PoD types that count as an artifact — something stored, as opposed to something asserted.
 */
const ARTIFACT_TYPES: readonly PodType[] = [PodType.SIGNATURE, PodType.PHOTO];

/**
 * `ProofOfDeliveryPolicy` (§3.3 F-STS-04, §10's `PodPolicy`, BR-DEL-06, BRULE-29) — whether a
 * given delivery needs proof, and whether the proof it has is enough.
 *
 * ## Why this is configuration and not a rule written into the code
 *
 * Because the design says it is not decided yet. `architecture/module-08-delivery-tracking.md`
 * lists it first under **Open Questions for Product/Compliance**: *"PoD policy — which orders
 * require photo/signature vs simple confirmation (BRULE-29)? Controlled/cold-chain always photo?"*
 * That is a question for a pharmacist and a regulator, not for this module, and BRULE-29 itself is
 * phrased as *"required **where policy mandates it**"* — it delegates rather than mandates.
 *
 * So the mechanism is complete and the mandate is empty. Every requirement defaults to `NONE`,
 * which is the honest description of where the project actually stands: no approved policy exists,
 * so the platform demands nothing and records whatever a driver offers. Turning it on is one
 * environment variable per rule, takes effect immediately, and needs no code change — which is
 * what §2's "replaceable/configurable rather than hardcoding one irreversible rule deep inside the
 * aggregate" asks for.
 *
 * Defaulting to `CONFIRMATION` was the tempting alternative and it would have been wrong. It reads
 * as harmless — one extra tap for the driver — but it is still a delivery policy nobody approved,
 * it would have changed the behaviour of every existing delivery flow on the platform, and a
 * customer who was out when their order arrived would have found the driver unable to complete a
 * delivery the platform had previously allowed. A safety rule that appears by default is a rule
 * nobody chose.
 *
 * ## The two inputs, and why only these two
 *
 * `isColdChain` and `isCod` are the only characteristics of a delivery that Module 08
 * authoritatively holds and that plausibly bear on evidence — the first because BRULE-30 already
 * singles cold-chain out for special handling and the design's open question names it explicitly,
 * the second because cash changing hands is the classic reason to want a signature. Neither is
 * *asserted* to require proof; both are given their own configurable knob so that whoever decides
 * can express the decision.
 *
 * Deliberately absent is anything about the medicines themselves — controlled substances, Rx
 * classification, schedule. Module 08 does not hold that (Module 03 and Module 05 do), and §2 is
 * explicit that inventing medical or legal requirements is out of scope. When compliance decides
 * that controlled drugs need a signature, the input arrives through `IOrdersPort` or
 * `ICatalogPort` and joins `PodPolicySubject`; guessing at it now would put a clinical rule in a
 * delivery module.
 */
export const ProofOfDeliveryPolicy = {
  /**
   * The requirement for one delivery: the strictest of the rules that apply to it.
   *
   * Strictest-wins rather than first-match, because the rules are independent statements about
   * risk and a delivery can be both cold-chain and cash-on-delivery. Taking the maximum means
   * adding a rule can only ever tighten the requirement for a delivery it applies to, which is the
   * safe direction for a policy whose purpose is evidence.
   */
  requirementFor(subject: PodPolicySubject, settings: PodPolicySettings): PodRequirement {
    const applicable = [
      settings.base,
      ...(subject.isColdChain ? [settings.coldChain] : []),
      ...(subject.isCod ? [settings.cod] : []),
    ];
    return applicable.reduce((strictest, candidate) =>
      STRENGTH[candidate] > STRENGTH[strictest] ? candidate : strictest,
    );
  },

  /**
   * Whether a captured proof satisfies a requirement.
   *
   * `null` proof satisfies only `NONE`. A `CONFIRMATION` proof satisfies `CONFIRMATION` but not
   * `ARTIFACT`; a signature or photo satisfies both. Note that a confirmation must actually be
   * *confirmed* — a row recording that the recipient declined to attest is evidence of something,
   * but it is not evidence of receipt, and letting it through would make the flag decorative.
   */
  isSatisfiedBy(
    requirement: PodRequirement,
    proof: { type: PodType; recipientConfirmed: boolean; artifactRef: string | null } | null,
  ): boolean {
    if (requirement === PodRequirement.None) {
      return true;
    }
    if (proof === null) {
      return false;
    }
    if (requirement === PodRequirement.Artifact) {
      return ARTIFACT_TYPES.includes(proof.type) && proof.artifactRef !== null;
    }
    // CONFIRMATION: any proof form will do, provided the recipient actually confirmed.
    return proof.recipientConfirmed;
  },

  /** Whether this PoD type carries a stored file. */
  isArtifactType(type: PodType): boolean {
    return ARTIFACT_TYPES.includes(type);
  },

  /**
   * The job states in which proof may be captured (§9 of this work's brief, §11.4).
   *
   * **`ARRIVED_DROPOFF` only.** Proof of delivery is evidence of a handover, and the handover
   * happens at the door: earlier the driver is not there, and later the job has already been
   * marked delivered on the strength of whatever evidence existed at the time. Allowing capture
   * after `DELIVERED` would let evidence gathered at an unknown moment be attached to a completed
   * delivery and presented as contemporaneous — which is precisely the "masquerade as current
   * delivery proof" the brief warns against — and allowing it before arrival would let a driver
   * photograph a doorstep they have not reached.
   *
   * The consequence is deliberate and worth stating: a driver who wants to record proof must post
   * `/arrived-dropoff` first. That is not an obstacle, it is the point — the status is the claim
   * that they are at the address, and the evidence is anchored to it.
   */
  isCaptureAllowedIn(status: DeliveryJobStatus): boolean {
    return status === DeliveryJobStatus.ARRIVED_DROPOFF;
  },
};
