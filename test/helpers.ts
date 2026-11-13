import { AddressInfo } from 'node:net';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { INestApplication } from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CONFIG, loadConfig } from '../src/common/config';
import { AppModule } from '../src/app.module';

export interface TestApp {
  app: INestApplication;
  port: number;
}

/** 启动真实 HTTP 服务（随机端口 + 独立 SQLite 文件） */
export async function startApp(
  dbPath: string,
  token = 'test-token',
  overrides: { busyTimeoutMs?: number } = {},
): Promise<TestApp> {
  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(CONFIG)
    .useValue({
      ...loadConfig({ CHATGROUP_TOKEN: token }),
      dbPath,
      host: '127.0.0.1',
      ...overrides,
    })
    .compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>({
    bodyParser: false,
    logger: false,
  });
  app.useBodyParser('json', { limit: '4mb' });
  app.enableShutdownHooks();
  await app.init();
  await app.listen(0);
  const port = (app.getHttpServer().address() as AddressInfo).port;
  return { app, port };
}

/** 创建带 Bearer Token 的 MCP 客户端（Streamable HTTP） */
export async function makeClient(port: number, token = 'test-token'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${port}/mcp`),
    { requestInit: { headers: { Authorization: `Bearer ${token}` } } },
  );
  const client = new Client({ name: 'e2e-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** 调用工具，失败时抛出带错误码的异常 */
export async function call<T = any>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) {
    const body = JSON.parse((result.content as { text: string }[])[0].text);
    throw new Error(`工具 ${name} 失败：${body.code} ${body.message}`);
  }
  return result.structuredContent as T;
}

/** 调用工具并断言返回结构化业务错误，返回 { code, message, details } */
export async function callExpectError(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<{ code: string; message: string; details?: Record<string, unknown> }> {
  const result = await client.callTool({ name, arguments: args });
  if (!result.isError) {
    throw new Error(`工具 ${name} 预期失败但成功了`);
  }
  const text = (result.content as { text: string }[])[0].text;
  try {
    return JSON.parse(text);
  } catch {
    // SDK 输入校验（zod）失败时返回非 JSON 文本，等价于参数无效
    return { code: 'INVALID_ARGUMENT', message: text };
  }
}

/** 独立临时目录（存放测试 SQLite 文件） */
export function tempDbDir(prefix = 'chatgroup-test-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
