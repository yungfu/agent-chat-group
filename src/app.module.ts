import { Module } from '@nestjs/common';
import { BoardModule } from './board/board.module';
import { CommonModule } from './common/common.module';
import { DatabaseModule } from './database/database.module';
import { GroupsModule } from './groups/groups.module';
import { McpModule } from './mcp/mcp.module';
import { MessagesModule } from './messages/messages.module';

@Module({
  imports: [CommonModule, DatabaseModule, GroupsModule, MessagesModule, BoardModule, McpModule],
})
export class AppModule {}
