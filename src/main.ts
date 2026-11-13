import 'reflect-metadata';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';
import { loadConfig } from './common/config';

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: ['log', 'warn', 'error'],
  });
  // 消息正文与 board value 均可达数十 KiB，放宽 JSON 请求体限制
  app.useBodyParser('json', { limit: '4mb' });
  app.enableShutdownHooks();
  await app.listen(config.port, config.host);
  const url = await app.getUrl();
  new Logger('ChatgroupServer').log(
    `chatgroup MCP server 已启动：${url}/mcp（Bearer Token 认证，数据库：${config.dbPath}）`,
  );
}

void bootstrap();
