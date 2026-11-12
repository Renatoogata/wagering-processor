import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { AppModule } from '../../../src/app.module';
import { configureHttp } from '../../../src/interfaces/http/configure-app';
import { startDatabase } from '../../integration/support/database';

export interface TestApp {
  app: INestApplication;
  baseUrl: string;
  close(): Promise<void>;
}

/** Sobe a aplicação REAL (mesmo módulo e configuração do main.ts) numa porta livre. */
export async function startApp(): Promise<TestApp> {
  const { orm } = await startDatabase(); // garante as migrations aplicadas
  await orm.close();

  // os e2e testam a API; consumer e publisher têm testes próprios com filas isoladas
  process.env.SQS_CONSUMER_ENABLED = 'false';
  process.env.OUTBOX_PUBLISHER_ENABLED = 'false';
  process.env.PENDING_REFERENCE_WORKER_ENABLED = 'false';
  const app = await NestFactory.create(AppModule, { logger: false });
  configureHttp(app);
  await app.listen(0);
  const baseUrl = (await app.getUrl()).replace('[::1]', 'localhost');
  return { app, baseUrl, close: () => app.close() };
}

export interface ApiResponse<T = any> {
  status: number;
  body: T;
  headers: Headers;
}

export function api(baseUrl: string) {
  async function call(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      ...(body !== undefined && { body: typeof body === 'string' ? body : JSON.stringify(body) }),
    });
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : undefined, headers: res.headers } as ApiResponse;
  }
  return {
    get: (path: string, headers?: Record<string, string>) => call('GET', path, undefined, headers),
    post: (path: string, body?: unknown, headers?: Record<string, string>) => call('POST', path, body, headers),
  };
}
