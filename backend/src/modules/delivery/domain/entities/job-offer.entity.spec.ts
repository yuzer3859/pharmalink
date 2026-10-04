import { ApiException } from '../../../../shared/errors/api-exception';
import { ErrorCode } from '../../../../shared/errors/error-codes';
import { JobOfferStatus } from '../enums';
import { JobOffer, OFFER_EXPIRY_REASON } from './job-offer.entity';

const NOW = new Date('2026-09-17T08:00:00.000Z');
const TTL = 30;
const AFTER_TTL = new Date(NOW.getTime() + (TTL + 1) * 1000);

function newOffer(round = 1): JobOffer {
  return JobOffer.create({
    id: 'offer-1',
    jobId: 'job-1',
    driverId: 'driver-1',
    round,
    ttlSeconds: TTL,
    now: NOW,
  });
}

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (err) {
    return (err as ApiException).code;
  }
  throw new Error('expected a throw');
}

describe('JobOffer', () => {
  describe('create', () => {
    it('starts OFFERED with its deadline already set', () => {
      const props = newOffer().toProps();
      expect(props.status).toBe(JobOfferStatus.OFFERED);
      expect(props.offeredAt).toEqual(NOW);
      expect(props.expiresAt).toEqual(new Date(NOW.getTime() + TTL * 1000));
      expect(props.respondedAt).toBeNull();
      expect(props.reason).toBeNull();
    });

    it('rejects a non-positive TTL', () => {
      expect(
        codeOf(() =>
          JobOffer.create({
            id: 'o',
            jobId: 'j',
            driverId: 'd',
            round: 1,
            ttlSeconds: 0,
            now: NOW,
          }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('rejects a round below 1', () => {
      expect(
        codeOf(() =>
          JobOffer.create({
            id: 'o',
            jobId: 'j',
            driverId: 'd',
            round: 0,
            ttlSeconds: TTL,
            now: NOW,
          }),
        ),
      ).toBe(ErrorCode.VALIDATION_ERROR);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Expiry
  // -------------------------------------------------------------------------------------------
  describe('expiry', () => {
    it('is live before the deadline', () => {
      const offer = newOffer();
      expect(offer.isLiveAt(NOW)).toBe(true);
      expect(offer.isExpiredAt(NOW)).toBe(false);
    });

    it('is still live exactly on the deadline', () => {
      // The boundary goes to the driver: an accept on the last millisecond is a job placed.
      const offer = newOffer();
      expect(offer.isExpiredAt(offer.expiresAt)).toBe(false);
      expect(offer.isLiveAt(offer.expiresAt)).toBe(true);
    });

    it('is expired one millisecond later', () => {
      const offer = newOffer();
      expect(offer.isExpiredAt(new Date(offer.expiresAt.getTime() + 1))).toBe(true);
    });

    it('is not live once answered, whatever the clock says', () => {
      const accepted = newOffer().accept(NOW);
      expect(accepted.isPending).toBe(false);
      expect(accepted.isLiveAt(NOW)).toBe(false);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Accept
  // -------------------------------------------------------------------------------------------
  describe('accept', () => {
    it('moves to ACCEPTED and stamps the response time', () => {
      const props = newOffer().accept(NOW).toProps();
      expect(props.status).toBe(JobOfferStatus.ACCEPTED);
      expect(props.respondedAt).toEqual(NOW);
    });

    it('refuses an expired offer', () => {
      expect(codeOf(() => newOffer().accept(AFTER_TTL))).toBe(ErrorCode.OFFER_EXPIRED);
    });

    it('refuses an already accepted offer', () => {
      const accepted = newOffer().accept(NOW);
      expect(codeOf(() => accepted.accept(NOW))).toBe(ErrorCode.JOB_ALREADY_ASSIGNED);
    });

    it('refuses an already declined offer', () => {
      const declined = newOffer().decline('busy', NOW);
      expect(codeOf(() => declined.accept(NOW))).toBe(ErrorCode.JOB_ALREADY_ASSIGNED);
    });

    it('refuses an expired offer even before checking whether it was answered', () => {
      // Order matters for the message a driver sees: "too late" is the truer explanation than
      // "somebody else took it" when the deadline passed and nobody answered at all.
      const offer = newOffer();
      expect(codeOf(() => offer.accept(AFTER_TTL))).toBe(ErrorCode.OFFER_EXPIRED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Decline
  // -------------------------------------------------------------------------------------------
  describe('decline', () => {
    it('moves to DECLINED with the reason and response time', () => {
      const props = newOffer().decline('Too far from me', NOW).toProps();
      expect(props.status).toBe(JobOfferStatus.DECLINED);
      expect(props.respondedAt).toEqual(NOW);
      expect(props.reason).toBe('Too far from me');
    });

    it('accepts no reason', () => {
      expect(newOffer().decline(null, NOW).toProps().reason).toBeNull();
    });

    it('normalises a blank reason to null', () => {
      expect(newOffer().decline('   ', NOW).toProps().reason).toBeNull();
    });

    it('rejects an over-long reason', () => {
      expect(codeOf(() => newOffer().decline('x'.repeat(500), NOW))).toBe(
        ErrorCode.VALIDATION_ERROR,
      );
    });

    it('refuses an expired offer', () => {
      // Declining after the deadline would claim a response the driver did not give in time, and
      // would overwrite the EXPIRED the dispatcher is entitled to write.
      expect(codeOf(() => newOffer().decline(null, AFTER_TTL))).toBe(ErrorCode.OFFER_EXPIRED);
    });

    it('refuses an already answered offer', () => {
      const declined = newOffer().decline(null, NOW);
      expect(codeOf(() => declined.decline(null, NOW))).toBe(ErrorCode.JOB_ALREADY_ASSIGNED);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Expire
  // -------------------------------------------------------------------------------------------
  describe('expire', () => {
    it('moves to EXPIRED with the expiry reason', () => {
      const props = newOffer().expire(AFTER_TTL).toProps();
      expect(props.status).toBe(JobOfferStatus.EXPIRED);
      expect(props.reason).toBe(OFFER_EXPIRY_REASON);
    });

    it('leaves respondedAt null', () => {
      // It records when the *driver* responded, and the point of an expiry is that they did not.
      expect(newOffer().expire(AFTER_TTL).toProps().respondedAt).toBeNull();
    });

    it('refuses to retire an offer that still has time', () => {
      // Otherwise a dispatcher could take a job from a driver who was still deciding, and offer
      // it to somebody else while the first driver's accept was in flight.
      expect(codeOf(() => newOffer().expire(NOW))).toBe(ErrorCode.CONFLICT);
    });

    it('refuses an already answered offer', () => {
      const accepted = newOffer().accept(NOW);
      expect(codeOf(() => accepted.expire(AFTER_TTL))).toBe(ErrorCode.CONFLICT);
    });
  });

  // -------------------------------------------------------------------------------------------
  // Rehydration
  // -------------------------------------------------------------------------------------------
  describe('rehydrate', () => {
    it('round-trips a live offer', () => {
      const props = newOffer().toProps();
      expect(JobOffer.rehydrate(props).toProps()).toEqual(props);
    });

    it('round-trips an accepted offer', () => {
      const props = newOffer().accept(NOW).toProps();
      expect(JobOffer.rehydrate(props).toProps()).toEqual(props);
    });

    it('refuses a pending offer that claims a response time', () => {
      const props = { ...newOffer().toProps(), respondedAt: NOW };
      expect(codeOf(() => JobOffer.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses an answered offer with no response time', () => {
      const props = { ...newOffer().toProps(), status: JobOfferStatus.ACCEPTED };
      expect(codeOf(() => JobOffer.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('refuses a deadline that precedes the offer', () => {
      const props = { ...newOffer().toProps(), expiresAt: new Date(NOW.getTime() - 1) };
      expect(codeOf(() => JobOffer.rehydrate(props))).toBe(ErrorCode.VALIDATION_ERROR);
    });

    it('accepts an EXPIRED offer with no response time', () => {
      const props = newOffer().expire(AFTER_TTL).toProps();
      expect(JobOffer.rehydrate(props).status).toBe(JobOfferStatus.EXPIRED);
    });
  });

  it('never mutates the instance a response was called on', () => {
    const offer = newOffer();
    const snapshot = offer.toProps();
    offer.accept(NOW);
    expect(offer.toProps()).toEqual(snapshot);
  });
});
