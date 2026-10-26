import { Provider } from '@nestjs/common';
import { AppConfigService } from '../../../../shared/config/app-config.service';
import {
  IDENTITY_VERIFICATION_PROVIDER_ENV,
  resolveIdentityVerificationProvider,
} from '../../../../shared/config/identity-verification.config';
import { AppLogger } from '../../../../shared/logging/app-logger.service';
import {
  IDENTITY_VERIFICATION_PROVIDER,
  IIdentityVerificationProvider,
} from '../../application/ports/identity-verification.provider';
import { MockFaydaProvider } from './mock-fayda.provider';

/**
 * Composition boundary for the real Fayda adapter (ADR-027).
 *
 * Bound to `null` because no real integration exists yet. A future adapter replaces this one
 * binding with its class (`{ provide: FAYDA_VERIFICATION_PROVIDER, useClass: FaydaHttpProvider }`)
 * and validates its own credentials when constructed; nothing else in the module, and no use case,
 * changes. Tests may override this token with a fake to exercise the wiring.
 */
export const FAYDA_VERIFICATION_PROVIDER = Symbol('FAYDA_VERIFICATION_PROVIDER');

/**
 * Chooses the `IIdentityVerificationProvider` at startup. Never falls back: selecting `fayda`
 * without a registered adapter throws, in every environment, and the mock is constructed only when
 * `mock` is selected (its own constructor still refuses production).
 */
export function selectIdentityVerificationProvider(
  config: AppConfigService,
  logger: AppLogger,
  fayda: IIdentityVerificationProvider | null,
): IIdentityVerificationProvider {
  const selected = resolveIdentityVerificationProvider(
    config.nodeEnv,
    config.get<string>(IDENTITY_VERIFICATION_PROVIDER_ENV),
  );

  if (selected === 'fayda') {
    if (!fayda) {
      throw new Error(
        `${IDENTITY_VERIFICATION_PROVIDER_ENV}=fayda, but no real IIdentityVerificationProvider is registered: ` +
          'FAYDA_VERIFICATION_PROVIDER is unbound because the Fayda integration has not been implemented. ' +
          'Refusing to start; the mock is never substituted. See ADR-027 in architecture/00-decision-log.md and backend/docs/runtime-identity-verification.md.',
      );
    }
    return fayda;
  }

  logger.setContext('IdentityVerification');
  logger.warn(
    'Identity verification uses MockFaydaProvider: a non-production stand-in that auto-approves well-formed IDs. It is not real Fayda verification.',
  );
  return new MockFaydaProvider(config, logger);
}

/** The identity module's verification-provider bindings; spread into `IdentityModule.providers`. */
export const identityVerificationProviders: Provider[] = [
  { provide: FAYDA_VERIFICATION_PROVIDER, useValue: null },
  {
    provide: IDENTITY_VERIFICATION_PROVIDER,
    useFactory: selectIdentityVerificationProvider,
    inject: [AppConfigService, AppLogger, FAYDA_VERIFICATION_PROVIDER],
  },
];
