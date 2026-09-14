import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bufferLogs: false });

  // Exactly two reverse-proxy hops sit in front of this process in every
  // deployment: the outer OpenResty (terminates public TLS) and the web
  // container's nginx (proxies /api/ -> api:4000, apps/web/nginx.conf). Each
  // appends to X-Forwarded-For, so the real client is the header's 3rd entry
  // from the right. `true` (trust every hop, unbounded) lets anyone who can
  // reach this container directly - bypassing both proxies, e.g. a
  // mis-published compose port - hand it an arbitrary X-Forwarded-For and
  // spoof req.ip, poisoning the audit log and any IP-based lockout. A fixed
  // hop count of 2 trusts exactly those two proxies and no further.
  app.set('trust proxy', 2);

  app.use(helmet());
  app.use(cookieParser());
  // The SPA is same-origin (served by the same nginx that proxies /api), so
  // CORS is only exercised if the API is reached from another origin. Keep the
  // allow-list tight to WEB_ORIGIN.
  app.enableCors({
    origin: cfg.WEB_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Tenant-Id'],
  });
  app.setGlobalPrefix('api', { exclude: ['health'] });
  app.enableShutdownHooks();

  await app.listen(cfg.API_PORT, '0.0.0.0');
  new Logger('bootstrap').log(`API listening on :${cfg.API_PORT} (prefix /api)`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
