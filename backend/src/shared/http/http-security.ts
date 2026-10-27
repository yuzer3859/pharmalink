import { INestApplication } from '@nestjs/common';
import type { Express } from 'express';
import helmet from 'helmet';
import { AppConfigService } from '../config/app-config.service';
import { parseTrustProxy } from '../config/http-security.config';

/**
 * Bootstrap-level HTTP hardening (Work 59), shared by `main.ts` and the e2e harness so tests run
 * the same stack that ships.
 *
 * **Trusted proxies.** `TRUST_PROXY` (validated at boot) becomes Express's `trust proxy`. By
 * default nothing is trusted: `req.ip` is the TCP peer and `X-Forwarded-*` is ignored, so neither
 * rate limiting nor `req.protocol` can be steered by a client-supplied header.
 *
 * **Security headers (Helmet).** This is a JSON API that serves no HTML, scripts or frames, so the
 * policy denies everything a browser could load from it:
 * - `Content-Security-Policy: default-src 'none'; frame-ancestors 'none'; base-uri 'none';
 *   form-action 'none'` — harmless to API clients (CSP governs documents, not fetch/XHR) and
 *   stops a response ever being rendered as a page.
 * - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
 *   `Cross-Origin-Opener-Policy`/`Cross-Origin-Resource-Policy: same-origin`, and Helmet's other
 *   defaults; `X-Powered-By` is removed. CORS (`WEB_ORIGIN`) still governs cross-origin fetches.
 * - `Strict-Transport-Security` only when `HTTP_HSTS_MAX_AGE_SECONDS` > 0, without
 *   `includeSubDomains`: local HTTP must never claim HTTPS, and other subdomains are not ours to pin.
 */
export function applyHttpSecurity(app: INestApplication, config: AppConfigService): void {
  const express = app.getHttpAdapter().getInstance() as Express;
  express.set('trust proxy', parseTrustProxy(config.get('TRUST_PROXY')));

  const hstsMaxAge = Number(config.get('HTTP_HSTS_MAX_AGE_SECONDS') ?? 0);
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'none'"],
          formAction: ["'none'"],
        },
      },
      frameguard: { action: 'deny' },
      strictTransportSecurity: hstsMaxAge > 0 ? { maxAge: hstsMaxAge, includeSubDomains: false } : false,
    }),
  );
}
