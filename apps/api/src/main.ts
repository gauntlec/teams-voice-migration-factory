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

  // Behind the reverse proxy (OpenResty) + the web container's nginx, so the
  // client address and scheme arrive in X-Forwarded-* headers. Trust them so
  // req.ip in the audit log is the real caller, not a docker gateway.
  app.set('trust proxy', true);

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
