import { Module } from '@nestjs/common';
import { DatabaseService } from './database.service';
import {
  BoardRepository,
  GroupsRepository,
  MessagesRepository,
  ParticipantsRepository,
} from './repositories';

/** 数据访问层：连接 + 迁移 + 各领域仓储 */
@Module({
  providers: [DatabaseService, GroupsRepository, ParticipantsRepository, MessagesRepository, BoardRepository],
  exports: [DatabaseService, GroupsRepository, ParticipantsRepository, MessagesRepository, BoardRepository],
})
export class DatabaseModule {}
