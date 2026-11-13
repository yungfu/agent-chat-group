import { Global, Module } from '@nestjs/common';
import { CONFIG, loadConfig } from './config';

/** 全局配置模块：启动时读取并校验环境变量 */
@Global()
@Module({
  providers: [{ provide: CONFIG, useFactory: () => loadConfig() }],
  exports: [CONFIG],
})
export class CommonModule {}
