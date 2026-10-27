import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { AppConfigService } from './shared/config/app-config.service';
import { AppLogger } from './shared/logging/app-logger.service';
import { applyHttpSecurity } from './shared/http/http-security';
import { RateLimitStorage } from './shared/http/rate-limit.storage';

async function bootstrap(): Promise<void> {
  // `rawBody` preserves the exact received bytes on `req.rawBody`. Payment provider webhooks
  // sign the raw payload, so verifying against a re-serialized parse of the JSON would fail on
  // any whitespace or key-order difference (module-07 §9.2).
  const app = await NestFactory.create(AppModule, { bufferLogs: true, rawBody: true });

  const logger = await app.resolve(AppLogger);
  logger.setContext('Bootstrap');
  app.useLogger(logger);

  app.enableShutdownHooks();

  const config = app.get(AppConfigService);
  const port = config.port;
  // Trusted proxies and security headers (Work 59); must run before any route handles a request.
  applyHttpSecurity(app, config);
  const allowedOrigins = (config.get<string>('WEB_ORIGIN') || 'http://localhost:5173')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({ origin: allowedOrigins.length === 1 ? allowedOrigins[0] : allowedOrigins });

  await app.listen(port);
  logger.log(`PharmaLink backend listening on port ${port} (${config.nodeEnv})`);
  logger.log(
    `HTTP security: trust proxy ${config.get<string>('TRUST_PROXY') || 'off'}; rate-limit counters ${app.get(RateLimitStorage).mode}`,
  );
}

void bootstrap();
