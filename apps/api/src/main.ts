import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

async function bootstrap() {
  const cfg = loadConfig();
  const app = await NestFactory.create(AppModule, { bufferLogs: false });

  app.use(helmet());
  app.use(cookieParser());
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
