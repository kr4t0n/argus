import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import compression from 'compression';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bufferLogs: false });
  // Session snapshots are chunk-heavy JSON (deltas + tool meta) that
  // gzips 5-10×; nothing fronts the API to compress for us — the
  // nginx gzip config only covers the web container's static assets.
  app.use(compression());
  app.enableCors({
    origin: true,
    credentials: true,
  });
  app.useGlobalPipes(
    new ValidationPipe({
      transform: true,
      whitelist: true,
      forbidNonWhitelisted: false,
    }),
  );

  const config = app.get(ConfigService);
  const port = config.get<number>('SERVER_PORT', 4000);
  await app.listen(port, '0.0.0.0');
  Logger.log(`Argus control plane listening on :${port}`, 'Bootstrap');
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Fatal boot error:', err);
  process.exit(1);
});
