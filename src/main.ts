import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { configureHttp } from './interfaces/http/configure-app';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  // repassa SIGTERM/SIGINT para os hooks onModuleDestroy/beforeApplicationShutdown
  // (o consumidor SQS vai usar isso para encerrar sem perder mensagens)
  app.enableShutdownHooks();
  configureHttp(app);

  const port = Number.parseInt(process.env.PORT ?? '3000', 10);
  await app.listen(port);
  console.log(JSON.stringify({ level: 'info', msg: 'http server listening', port }));
}

void bootstrap();
