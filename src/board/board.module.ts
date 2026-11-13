import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { BoardService } from './board.service';

/** Board 共享条目：进展、成果、约定的键值存储与版本检查 */
@Module({
  imports: [DatabaseModule],
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
