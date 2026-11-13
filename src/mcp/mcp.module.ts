import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { GroupsModule } from '../groups/groups.module';
import { MessagesModule } from '../messages/messages.module';
import { TokenGuard } from '../auth/token.guard';
import { McpController } from './mcp.controller';
import { McpServerFactory } from './mcp.factory';

/** MCP 协议适配层：SDK 接入、工具注册、输入输出映射 */
@Module({
  imports: [GroupsModule, MessagesModule, BoardModule],
  controllers: [McpController],
  providers: [TokenGuard, McpServerFactory],
})
export class McpModule {}
