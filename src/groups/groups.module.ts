import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MessagesModule } from '../messages/messages.module';
import { GroupsService } from './groups.service';

/** 聊天组生命周期、参与者加入 / 声明 / 退出 */
@Module({
  imports: [DatabaseModule, MessagesModule],
  providers: [GroupsService],
  exports: [GroupsService],
})
export class GroupsModule {}
