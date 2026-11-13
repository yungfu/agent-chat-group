import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, ChatgroupConfig } from '../common/config';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { BusinessError, invalidArgument } from '../common/errors';
import { assertTextBytes, utf8Bytes } from '../common/validation';
import { BoardEntryRow, BoardRepository, GroupsRepository, ParticipantsRepository } from '../database/repositories';
import { DatabaseService } from '../database/database.service';
import { requireMember } from '../groups/membership';

export interface BoardEntryView {
  key: string;
  value: unknown;
  version: number;
  updated_by: string;
  updated_at: string;
}

function toEntryView(entry: BoardEntryRow): BoardEntryView {
  return {
    key: entry.key,
    value: entry.valueJson === null ? null : JSON.parse(entry.valueJson),
    version: entry.version,
    updated_by: entry.updatedBy,
    updated_at: entry.updatedAt,
  };
}

/** Board 共享条目：乐观并发（版本条件）、墓碑、重建 */
@Injectable()
export class BoardService {
  constructor(
    private readonly db: DatabaseService,
    private readonly groupsRepo: GroupsRepository,
    private readonly participantsRepo: ParticipantsRepository,
    private readonly boardRepo: BoardRepository,
    @Inject(CONFIG) private readonly config: ChatgroupConfig,
  ) {}

  /** 键名升序、隐藏墓碑的游标分页 */
  list(args: {
    groupId: string;
    participantId: string;
    cursor?: string;
    limit?: number;
  }): { entries: BoardEntryView[]; next_cursor: string | null } {
    const afterKey = args.cursor ? decodeCursor(args.cursor) : null;
    const limit = this.normalizeLimit(args.limit);
    return this.db.tx(
      () => {
        requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
          activeGroup: false,
        });
        const rows = this.boardRepo.listAfterKey(args.groupId, afterKey, limit + 1);
        const page = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return {
          entries: page.map(toEntryView),
          next_cursor: hasMore ? encodeCursor(page[page.length - 1].key) : null,
        };
      },
      'deferred',
    );
  }

  get(args: { groupId: string; participantId: string; key: string }): BoardEntryView {
    return this.db.tx(
      () => {
        requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
          activeGroup: false,
        });
        this.validateKey(args.key);
        const entry = this.boardRepo.find(args.groupId, args.key);
        if (!entry) {
          throw new BusinessError('BOARD_ENTRY_NOT_FOUND', 'Board 条目不存在', {
            group_id: args.groupId,
            key: args.key,
          });
        }
        if (entry.deletedAt !== null) {
          throw new BusinessError('BOARD_ENTRY_DELETED', 'Board 条目已删除', {
            group_id: args.groupId,
            key: args.key,
            version: entry.version,
          });
        }
        return toEntryView(entry);
      },
      'deferred',
    );
  }

  /**
   * 写入条目：
   * - expected_version=0 创建，要求键从未存在；
   * - expected_version=N 修改/重建（N 匹配当前版本，含墓碑版本），成功后版本递增。
   */
  put(args: {
    groupId: string;
    participantId: string;
    key: string;
    value: unknown;
    expectedVersion: number;
  }): BoardEntryView {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: true,
      });
      this.validateKey(args.key);
      if (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 0) {
        throw invalidArgument('expected_version 必须是 >= 0 的整数');
      }
      const { boardValueMaxBytes } = this.config.limits;
      const valueJson = JSON.stringify(args.value);
      assertTextBytes(valueJson, boardValueMaxBytes, 'board value');

      const updatedAt = new Date().toISOString();
      const existing = this.boardRepo.find(args.groupId, args.key);

      if (args.expectedVersion === 0) {
        if (!existing) {
          const entry: BoardEntryRow = {
            groupId: args.groupId,
            key: args.key,
            valueJson,
            version: 1,
            updatedBy: args.participantId,
            updatedAt,
            deletedAt: null,
          };
          this.boardRepo.insert(entry);
          return toEntryView(entry);
        }
        if (existing.deletedAt !== null) {
          throw new BusinessError(
            'BOARD_ENTRY_DELETED',
            '该键已存在墓碑记录，创建（expected_version=0）要求键从未存在；请携带墓碑版本重建',
            { group_id: args.groupId, key: args.key, version: existing.version },
          );
        }
        throw new BusinessError('VERSION_CONFLICT', '该键已存在，创建请改用当前版本号', {
          group_id: args.groupId,
          key: args.key,
          actual_version: existing.version,
        });
      }

      if (!existing) {
        throw new BusinessError('BOARD_ENTRY_NOT_FOUND', 'Board 条目不存在', {
          group_id: args.groupId,
          key: args.key,
        });
      }
      // 带版本条件的 UPDATE：命中墓碑版本则重建，版本不匹配则冲突
      const result = this.boardRepo.updateWithVersion(
        args.groupId,
        args.key,
        valueJson,
        args.expectedVersion,
        args.participantId,
        updatedAt,
      );
      if (result.changes === 0) {
        throw new BusinessError('VERSION_CONFLICT', '版本冲突，条目已被他人修改', {
          group_id: args.groupId,
          key: args.key,
          actual_version: existing.version,
          expected_version: args.expectedVersion,
        });
      }
      return toEntryView({
        ...existing,
        valueJson,
        version: args.expectedVersion + 1,
        updatedBy: args.participantId,
        updatedAt,
        deletedAt: null,
      });
    });
  }

  /** 删除：保留墓碑并递增版本，避免删除后重建导致旧版本误匹配 */
  delete(args: {
    groupId: string;
    participantId: string;
    key: string;
    expectedVersion: number;
  }): { key: string; version: number; deleted: boolean } {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: true,
      });
      this.validateKey(args.key);
      if (!Number.isInteger(args.expectedVersion) || args.expectedVersion < 0) {
        throw invalidArgument('expected_version 必须是 >= 0 的整数');
      }
      const existing = this.boardRepo.find(args.groupId, args.key);
      if (!existing) {
        throw new BusinessError('BOARD_ENTRY_NOT_FOUND', 'Board 条目不存在', {
          group_id: args.groupId,
          key: args.key,
        });
      }
      if (existing.deletedAt !== null) {
        throw new BusinessError('BOARD_ENTRY_DELETED', 'Board 条目已删除', {
          group_id: args.groupId,
          key: args.key,
          version: existing.version,
        });
      }
      const result = this.boardRepo.markDeleted(
        args.groupId,
        args.key,
        args.expectedVersion,
        new Date().toISOString(),
      );
      if (result.changes === 0) {
        throw new BusinessError('VERSION_CONFLICT', '版本冲突，条目已被他人修改', {
          group_id: args.groupId,
          key: args.key,
          actual_version: existing.version,
          expected_version: args.expectedVersion,
        });
      }
      return { key: args.key, version: args.expectedVersion + 1, deleted: true };
    });
  }

  private validateKey(key: string): void {
    const { boardKeyMaxChars } = this.config.limits;
    if (key.length === 0) {
      throw invalidArgument('board key 不能为空');
    }
    if (key.length > boardKeyMaxChars || utf8Bytes(key) > boardKeyMaxChars * 4) {
      throw invalidArgument(`board key 最多 ${boardKeyMaxChars} 个字符`, {
        actual: key.length,
        max: boardKeyMaxChars,
      });
    }
  }

  private normalizeLimit(limit: number | undefined): number {
    const { pageDefault, pageMax } = this.config.limits;
    if (limit === undefined) return pageDefault;
    if (!Number.isInteger(limit) || limit < 1 || limit > pageMax) {
      throw invalidArgument(`limit 必须是 1 到 ${pageMax} 之间的整数`, { limit, max: pageMax });
    }
    return limit;
  }
}
