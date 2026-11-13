import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { MessagesService } from './messages.service';

/** 消息流：发送、回复关联、主动读取与确认、历史查询 */
@Module({
  imports: [DatabaseModule],
  providers: [MessagesService],
  exports: [MessagesService],
})
export class MessagesModule {}
