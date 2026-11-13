import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, ChatgroupConfig } from '../common/config';
import { decodeCursor, encodeCursor } from '../common/cursor';
import { invalidArgument } from '../common/errors';
import { newId } from '../common/ids';
import { assertTextBytes } from '../common/validation';
import {
  Group,
  GroupsRepository,
  Participant,
  ParticipantsRepository,
} from '../database/repositories';
import { DatabaseService } from '../database/database.service';
import { requireActiveGroup, requireGroup, requireMember } from './membership';
import { MessagesService } from '../messages/messages.service';

export interface GroupView {
  group_id: string;
  name: string;
  description: string;
  status: 'active' | 'closed';
  created_at: string;
  closed_at: string | null;
}

export interface ParticipantView {
  participant_id: string;
  display_name: string;
  declaration: string;
  last_read_seq: number;
  joined_at: string;
  left_at: string | null;
}

export function toGroupView(group: Group): GroupView {
  return {
    group_id: group.groupId,
    name: group.name,
    description: group.description,
    status: group.status,
    created_at: group.createdAt,
    closed_at: group.closedAt,
  };
}

export function toParticipantView(participant: Participant): ParticipantView {
  return {
    participant_id: participant.participantId,
    display_name: participant.displayName,
    declaration: participant.declaration,
    last_read_seq: participant.lastReadSeq,
    joined_at: participant.joinedAt,
    left_at: participant.leftAt,
  };
}

/** 聊天组生命周期与参与者管理 */
@Injectable()
export class GroupsService {
  constructor(
    private readonly db: DatabaseService,
    private readonly groupsRepo: GroupsRepository,
    private readonly participantsRepo: ParticipantsRepository,
    private readonly messagesService: MessagesService,
    @Inject(CONFIG) private readonly config: ChatgroupConfig,
  ) {}

  /** 创建组不会自动加入：创建和加入是两个独立动作 */
  create(args: { name: string; description?: string }): GroupView {
    const { nameMaxChars, descriptionMaxBytes } = this.config.limits;
    const name = args.name;
    if (name.trim().length === 0) {
      throw invalidArgument('组名称不能为空');
    }
    if (name.length > nameMaxChars) {
      throw invalidArgument(`组名称最多 ${nameMaxChars} 个字符`, { actual: name.length, max: nameMaxChars });
    }
    const description = args.description ?? '';
    assertTextBytes(description, descriptionMaxBytes, '组说明');

    const group: Group = {
      groupId: newId('grp'),
      name,
      description,
      status: 'active',
      lastSeq: 0,
      createdAt: new Date().toISOString(),
      closedAt: null,
    };
    this.db.tx(() => this.groupsRepo.insert(group));
    return toGroupView(group);
  }

  list(args: { cursor?: string; limit?: number }): {
    groups: GroupView[];
    next_cursor: string | null;
  } {
    const afterRowid = args.cursor ? this.decodeRowidCursor(args.cursor) : 0;
    const limit = this.normalizeLimit(args.limit);
    return this.db.tx(
      () => {
        const { groups, lastRowid } = this.groupsRepo.listAfterRowid(afterRowid, limit + 1);
        const page = groups.slice(0, limit);
        const hasMore = groups.length > limit;
        return {
          groups: page.map(toGroupView),
          next_cursor: hasMore ? encodeCursor(String(lastRowid)) : null,
        };
      },
      'deferred',
    );
  }

  get(groupId: string): { group: GroupView; participants: ParticipantView[] } {
    return this.db.tx(
      () => {
        const group = requireGroup(this.groupsRepo, groupId);
        // 含已退出成员，便于历史引用与身份恢复判断
        const participants = this.participantsRepo.listByGroup(groupId).map(toParticipantView);
        return { group: toGroupView(group), participants };
      },
      'deferred',
    );
  }

  /**
   * 加入：同一事务内读取当前组序号 N，将 last_read_seq 设为 N，
   * 再追加加入系统消息，保证加入与并发写入不漏消息（设计 §6.3）。
   */
  join(args: {
    groupId: string;
    displayName: string;
    declaration?: string;
  }): { self: ParticipantView; group: GroupView; participants: ParticipantView[] } {
    return this.db.tx(() => {
      const group = requireActiveGroup(this.groupsRepo, args.groupId);

      const { nameMaxChars, declarationMaxBytes } = this.config.limits;
      const displayName = args.displayName;
      if (displayName.trim().length === 0) {
        throw invalidArgument('展示名称不能为空');
      }
      if (displayName.length > nameMaxChars) {
        throw invalidArgument(`展示名称最多 ${nameMaxChars} 个字符`, {
          actual: displayName.length,
          max: nameMaxChars,
        });
      }
      const declaration = args.declaration ?? '';
      assertTextBytes(declaration, declarationMaxBytes, '参与者声明');

      const self: Participant = {
        participantId: newId('p'),
        groupId: args.groupId,
        displayName,
        declaration,
        lastReadSeq: group.lastSeq,
        joinedAt: new Date().toISOString(),
        leftAt: null,
      };
      this.insertParticipant(self);

      this.messagesService.appendMessage(args.groupId, {
        type: 'participant.joined',
        actorParticipantId: self.participantId,
        text: `「${displayName}」加入了组（${self.participantId}）`,
        payload: { display_name: displayName, declaration },
      });

      return {
        self: toParticipantView(self),
        group: toGroupView(group),
        participants: this.participantsRepo.listActive(args.groupId).map(toParticipantView),
      };
    });
  }

  /** 关闭：重复调用不重复追加系统消息 */
  close(groupId: string): GroupView {
    return this.db.tx(() => {
      const group = requireGroup(this.groupsRepo, groupId);
      if (group.status === 'closed') {
        return toGroupView(group);
      }
      const closedAt = new Date().toISOString();
      this.groupsRepo.close(groupId, closedAt);
      this.messagesService.appendMessage(groupId, {
        type: 'group.closed',
        text: '组已关闭，禁止加入和写入，仍可读取和确认接收',
        payload: { closed_at: closedAt },
      });
      return toGroupView({ ...group, status: 'closed', closedAt });
    });
  }

  /** 销毁：删除组及其全部关联数据 */
  delete(groupId: string): { group_id: string; deleted: boolean } {
    return this.db.tx(() => {
      requireGroup(this.groupsRepo, groupId);
      this.groupsRepo.deleteGroupCascade(groupId);
      return { group_id: groupId, deleted: true };
    });
  }

  /** 更新自我声明，与系统消息原子完成 */
  updateParticipant(args: {
    groupId: string;
    participantId: string;
    displayName?: string;
    declaration?: string;
  }): ParticipantView {
    return this.db.tx(() => {
      const { participant } = requireMember(
        this.groupsRepo,
        this.participantsRepo,
        args.groupId,
        args.participantId,
        { activeGroup: true },
      );
      if (args.displayName === undefined && args.declaration === undefined) {
        throw invalidArgument('至少提供 display_name 或 declaration 之一');
      }
      const { nameMaxChars, declarationMaxBytes } = this.config.limits;
      if (args.displayName !== undefined) {
        if (args.displayName.trim().length === 0) {
          throw invalidArgument('展示名称不能为空');
        }
        if (args.displayName.length > nameMaxChars) {
          throw invalidArgument(`展示名称最多 ${nameMaxChars} 个字符`, {
            actual: args.displayName.length,
            max: nameMaxChars,
          });
        }
      }
      if (args.declaration !== undefined) {
        assertTextBytes(args.declaration, declarationMaxBytes, '参与者声明');
      }

      const displayName = args.displayName ?? participant.displayName;
      const declaration = args.declaration ?? participant.declaration;
      this.participantsRepo.updateProfile(args.participantId, displayName, declaration);
      this.messagesService.appendMessage(args.groupId, {
        type: 'participant.updated',
        actorParticipantId: args.participantId,
        text: `「${displayName}」更新了自我声明`,
        payload: { display_name: displayName, declaration },
      });
      return toParticipantView({ ...participant, displayName, declaration });
    });
  }

  leave(args: { groupId: string; participantId: string }): ParticipantView {
    return this.db.tx(() => {
      const { participant } = requireMember(
        this.groupsRepo,
        this.participantsRepo,
        args.groupId,
        args.participantId,
        { activeGroup: true },
      );
      const leftAt = new Date().toISOString();
      this.participantsRepo.markLeft(args.participantId, leftAt);
      this.messagesService.appendMessage(args.groupId, {
        type: 'participant.left',
        actorParticipantId: args.participantId,
        text: `「${participant.displayName}」退出了组（${args.participantId}）`,
        payload: { display_name: participant.displayName },
      });
      return toParticipantView({ ...participant, leftAt });
    });
  }

  /** 参与者随机 ID 极小概率冲突时换 ID 重试 */
  private insertParticipant(participant: Participant): void {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        this.participantsRepo.insert(participant);
        return;
      } catch (error) {
        if (!this.db.isUniqueViolation(error)) throw error;
        lastError = error;
        participant = { ...participant, participantId: newId('p') };
      }
    }
    throw lastError;
  }

  private decodeRowidCursor(cursor: string): number {
    const decoded = decodeCursor(cursor);
    if (!/^\d+$/.test(decoded)) {
      throw invalidArgument('cursor 无效');
    }
    return Number.parseInt(decoded, 10);
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
