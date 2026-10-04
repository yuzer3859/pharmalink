import { Injectable } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  FaydaVerificationInput,
  FaydaVerificationResult,
  IIdentityVerificationProvider,
} from '../../application/ports/identity-verification.provider';

/** Fayda FIN/FAN is a 12- or 16-digit number. */
const FAYDA_ID_PATTERN = /^\d{12}(\d{4})?$/;

/**
 * Development/staging stand-in for the Fayda verification API (module-01 §9). Applies the format
 * rule only; a real match against the national registry is out of reach until the provider
 * contract exists. Refuses to run in production so a missing integration can never be mistaken
 * for a passing identity check.
 */
@Injectable()
export class MockFaydaProvider implements IIdentityVerificationProvider {
  constructor(
    private readonly config: AppConfigService,
    private readonly logger: AppLogger,
  ) {
    this.logger.setContext(MockFaydaProvider.name);
    if (this.config.isProduction) {
      throw new Error(
        'MockFaydaProvider must not be used in production — wire a real IIdentityVerificationProvider.',
      );
    }
  }

  async verifyFayda(input: FaydaVerificationInput): Promise<FaydaVerificationResult> {
    const normalized = input.faydaId.replace(/\s/g, '');

    if (!FAYDA_ID_PATTERN.test(normalized)) {
      return { matched: false, failureReason: 'The Fayda ID number format is not valid.' };
    }

    this.logger.warn({
      message: 'Fayda verification auto-approved by the mock provider',
      last4: normalized.slice(-4),
    });

    return { matched: true, providerReference: `MOCK-${normalized.slice(-4)}` };
  }
}
