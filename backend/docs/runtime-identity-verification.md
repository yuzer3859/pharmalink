# Runtime mode and identity-verification provider

How the backend chooses its national-ID (Fayda) verification provider, and why production does not start yet. Decision record: ADR-027 in `architecture/00-decision-log.md`.

**E-mail verification is not identity verification (Work 62).** Verifying an e-mail OTP proves control of the address and activates a pending customer account. It never sets `faydaVerifiedAt`, never creates or approves a verification request, and satisfies no identity, licensing or business-verification requirement. Nothing in this document changed.

## The contract

Two separate settings:

- **`NODE_ENV`** (`development` | `test` | `production`): the runtime mode. Unchanged by this work. `test` is for the automated suites only; it disables background jobs.
- **`IDENTITY_VERIFICATION_PROVIDER`** (`mock` | `fayda`): which `IIdentityVerificationProvider` the identity module uses.

| `NODE_ENV` | `IDENTITY_VERIFICATION_PROVIDER` unset | `mock` | `fayda` |
|---|---|---|---|
| `development` | mock | mock | real adapter, or **startup fails** if none is registered |
| `test` | mock | mock | real adapter, or **startup fails** if none is registered |
| `production` | **rejected at boot** | **rejected at boot** | real adapter, or **startup fails** if none is registered (today: always fails) |

Any other value (`Fayda`, `real`, …) is rejected at boot in every mode. Nothing is silently replaced by a default and nothing falls back from `fayda` to `mock`.

- **Where it's enforced:**
  - `src/shared/config/identity-verification.config.ts` holds the rule, `resolveIdentityVerificationProvider`.
  - `src/shared/config/env.validation.ts` applies it at boot: the allowed values, plus the cross-check against `NODE_ENV`.
  - `src/modules/identity/infrastructure/verification/identity-verification.providers.ts` applies it again when the module is composed: the factory and the composition-boundary token.
- **The mock keeps its own guard:** `MockFaydaProvider` still throws if it is ever constructed with `NODE_ENV=production`.
- **No secrets:** the setting names a provider, not a credential.

### Environments

- **Development and test:** unset is fine and gives the mock, which is what CI and local work use.
- **Local staging rehearsal** (`compose.staging.yml`): runs `NODE_ENV=development`, so the mock with synthetic data only. It does **not** exercise production mode. A passing rehearsal shows the backend packages, migrates, seeds and starts. It does not show production-mode readiness: the production provider rule, the real adapter and the other production blockers listed in `ops/staging/README.md` are all outside it.
- **A hosted staging environment:** not defined yet. Running it as `production` is blocked until a real adapter exists. Running it as `development` means the mock, synthetic data only, and must never be presented as real verification. That choice belongs to the release owner and must be recorded.
- **Production:** `NODE_ENV=production` plus `IDENTITY_VERIFICATION_PROVIDER=fayda`, and startup succeeds only once a real adapter is registered. Today it fails with:
  > `IDENTITY_VERIFICATION_PROVIDER=fayda, but no real IIdentityVerificationProvider is registered: FAYDA_VERIFICATION_PROVIDER is unbound because the Fayda integration has not been implemented. Refusing to start; the mock is never substituted.`

## Registering a real provider (future work)

1. Implement `IIdentityVerificationProvider` (`application/ports/identity-verification.provider.ts`) in `infrastructure/verification/`. Read its credentials through `IConfigPort`, in the same way as `TelebirrConfig` and `ResendConfig`, and **throw in the constructor** if any is missing, so a misconfigured adapter stops startup instead of failing per request.
2. Bind it at the composition boundary, replacing `{ provide: FAYDA_VERIFICATION_PROVIDER, useValue: null }` with `useClass: YourAdapter`. No use case and no other binding changes.
3. Never log the Fayda identifier, the person's details or credentials. The mock logs only the last four digits.
4. Test it:
   - unit tests for the adapter against the provider's documented contract, including errors and timeouts;
   - the existing DI tests in `identity-verification.providers.spec.ts`, updated so that "fayda without an adapter fails" still holds when the binding is removed;
   - a production-mode startup test with the real adapter and valid sandbox credentials.

**Needed before step 1 is possible:**
- the official Fayda/NIDP API contract and environments;
- how credentials are issued and rotated;
- what must be sent and matched (FIN/FAN, name, date of birth);
- error and timeout semantics;
- data-protection obligations for the identifier;
- a sandbox to test against.

None of these exist in the repository, so no adapter has been written.

## What the tests prove

`src/shared/config/identity-verification.config.spec.ts` checks the rule and `validateEnv`. `identity-verification.providers.spec.ts` compiles the module's real bindings in a Nest testing module and covers:
1. non-production selects the mock;
2. invalid or contradictory values are rejected by validation, and by composition if validation were bypassed;
3. production with `mock` (or unset) fails;
4. production with `fayda` and no adapter fails, with the message above;
5. production with `fayda` and a supplied adapter wires it into the unchanged `SubmitFaydaVerificationCommand`;
6. the mock's own production guard;
7. no fallback to the mock in any mode.

Case 5 uses a **test-only fake**. It proves the composition boundary accepts a real adapter. It does **not** prove that Fayda verification works, that production starts with a real provider, or anything about the provider's behaviour. Production startup has **not** been tested with a real provider, because none exists.
