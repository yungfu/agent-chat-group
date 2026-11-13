import { Inject, Injectable } from '@nestjs/common';
import { CONFIG, ChatgroupConfig } from '../common/config';
import { BusinessError, invalidArgument } from '../common/errors';
import { newId } from '../common/ids';
import { assertTextBytes } from '../common/validation';
import {
  Group,
  GroupsRepository,
  MessageRow,
  MessagesRepository,
  MessageType,
  Participant,
  ParticipantsRepository,
} from '../database/repositories';
import { DatabaseService } from '../database/database.service';
import { requireMember } from '../groups/membership';
import { buildMessageViews, MessageView } from './message-view';

export interface AppendMessageInput {
  type: MessageType;
  senderId?: string;
  actorParticipantId?: string;
  text: string;
  /** 系统消息快照（如加入时的声明） */
  payload?: unknown;
  replyToMessageId?: string | null;
  threadRootMessageId?: string | null;
  mentions?: string[];
}

@Injectable()
export class MessagesService {
  constructor(
    private readonly db: DatabaseService,
    private readonly groupsRepo: GroupsRepository,
    private readonly participantsRepo: ParticipantsRepository,
    private readonly messagesRepo: MessagesRepository,
    @Inject(CONFIG) private readonly config: ChatgroupConfig,
  ) {}

  /**
   * 内部：向组消息流追加一条记录（普通消息或系统消息）。
   * seq 分配与插入原子完成（设计 §9），必须在调用方事务内执行。
   */
  appendMessage(groupId: string, input: AppendMessageInput): MessageRow {
    const seq = this.groupsRepo.bumpSeq(groupId);
    if (seq === undefined) {
      throw new BusinessError('GROUP_NOT_FOUND', '聊天组不存在或已销毁', { group_id: groupId });
    }
    const createdAt = new Date().toISOString();
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const messageId = newId('msg');
      const row: MessageRow = {
        messageId,
        groupId,
        seq,
        type: input.type,
        senderId: input.senderId ?? null,
        actorParticipantId: input.actorParticipantId ?? null,
        text: input.text,
        payloadJson: input.payload === undefined ? null : JSON.stringify(input.payload),
        replyToMessageId: input.replyToMessageId ?? null,
        // 未回复任何消息时，讨论根就是自身（设计 §5.2）；系统消息不属于讨论
        threadRootMessageId:
          input.threadRootMessageId ?? (input.type === 'message' ? messageId : null),
        createdAt,
      };
      try {
        this.messagesRepo.insert(row);
        if (input.mentions && input.mentions.length > 0) {
          this.messagesRepo.insertMentions(row.messageId, input.mentions);
        }
        return row;
      } catch (error) {
        if (!this.db.isUniqueViolation(error)) throw error;
        lastError = error; // 随机 ID 极小概率冲突，换 ID 重试
      }
    }
    throw lastError;
  }

  /** 发送普通消息：校验成员、正文、@ 与回复目标，写入统一消息流 */
  send(args: {
    groupId: string;
    participantId: string;
    text: string;
    mentions?: string[];
    replyToMessageId?: string;
  }): MessageView {
    return this.db.tx(() => {
      const { participant } = requireMember(
        this.groupsRepo,
        this.participantsRepo,
        args.groupId,
        args.participantId,
        { activeGroup: true },
      );

      const { textMaxBytes, mentionMaxCount } = this.config.limits;
      const text = args.text;
      if (text.trim().length === 0) {
        throw invalidArgument('消息正文不能为空');
      }
      assertTextBytes(text, textMaxBytes, '消息正文');

      const mentions = [...new Set(args.mentions ?? [])];
      if (mentions.length > mentionMaxCount) {
        throw invalidArgument(`mentions 数量超过上限 ${mentionMaxCount}`, {
          actual: mentions.length,
          max: mentionMaxCount,
        });
      }
      for (const mention of mentions) {
        if (typeof mention !== 'string' || mention.length === 0) {
          throw invalidArgument('mentions 中的参与者 ID 不能为空', { mention });
        }
        const target = this.participantsRepo.findByIdInGroup(mention, args.groupId);
        if (!target || target.leftAt !== null) {
          throw new BusinessError(
            'INVALID_MENTION',
            `@ 的参与者无效（必须是本组当前活跃成员）：${mention}`,
            { mention },
          );
        }
      }

      let threadRootMessageId: string | null = null;
      if (args.replyToMessageId !== undefined) {
        const target = this.messagesRepo.findByIdInGroup(args.replyToMessageId, args.groupId);
        if (!target) {
          throw new BusinessError('MESSAGE_NOT_FOUND', '回复的目标消息不存在', {
            message_id: args.replyToMessageId,
          });
        }
        if (target.type !== 'message') {
          throw new BusinessError('INVALID_REPLY_TARGET', '只能回复普通消息，不能回复系统消息', {
            message_id: target.messageId,
          });
        }
        threadRootMessageId = target.threadRootMessageId ?? target.messageId;
      }

      const row = this.appendMessage(args.groupId, {
        type: 'message',
        senderId: args.participantId,
        text,
        replyToMessageId: args.replyToMessageId,
        threadRootMessageId,
        mentions,
      });
      return buildMessageViews([row], args.participantId, this.messagesRepo)[0];
    });
  }

  /**
   * 主动读取：从 last_read_seq 之后扫描至多 limit 条流记录，
   * 返回他人普通消息与全部系统消息；read 不推进读取位置。
   */
  read(args: {
    groupId: string;
    participantId: string;
    limit?: number;
  }): { messages: MessageView[]; read_receipt: string | null; has_more: boolean } {
    return this.db.tx(() => {
      const { participant } = requireMember(
        this.groupsRepo,
        this.participantsRepo,
        args.groupId,
        args.participantId,
        { activeGroup: false },
      );
      const limit = this.normalizeLimit(args.limit);

      const rows = this.messagesRepo.listAfterSeq(args.groupId, participant.lastReadSeq, limit + 1);
      if (rows.length === 0) {
        return { messages: [], read_receipt: null, has_more: false };
      }
      const scanned = rows.slice(0, limit);
      const throughSeq = scanned[scanned.length - 1].seq;
      const hasMore = rows.length > limit;
      const visible = scanned.filter(
        (row) => row.type !== 'message' || row.senderId !== args.participantId,
      );

      // 只要扫描位置前进就签发回执，即使过滤后返回为空
      const receiptId = newId('rr');
      this.messagesRepo.insertReceipt({
        id: receiptId,
        groupId: args.groupId,
        participantId: args.participantId,
        fromSeq: participant.lastReadSeq + 1,
        throughSeq,
        createdAt: new Date().toISOString(),
      });

      return {
        messages: buildMessageViews(visible, args.participantId, this.messagesRepo),
        read_receipt: receiptId,
        has_more: hasMore,
      };
    });
  }

  /** 确认接收：校验回执绑定信息，读取位置只前进不后退，重复 ack 安全 */
  ack(args: { groupId: string; participantId: string; readReceipt: string }): { last_read_seq: number } {
    return this.db.tx(() => {
      const { participant } = requireMember(
        this.groupsRepo,
        this.participantsRepo,
        args.groupId,
        args.participantId,
        { activeGroup: false },
      );
      const receipt = this.messagesRepo.findReceiptById(args.readReceipt);
      if (!receipt || receipt.groupId !== args.groupId || receipt.participantId !== args.participantId) {
        throw new BusinessError('INVALID_READ_RECEIPT', '读取回执无效或不属于当前参与者', {
          group_id: args.groupId,
          participant_id: args.participantId,
        });
      }
      const lastReadSeq = Math.max(participant.lastReadSeq, receipt.throughSeq);
      this.participantsRepo.raiseLastRead(args.participantId, lastReadSeq);
      return { last_read_seq: lastReadSeq };
    });
  }

  get(args: { groupId: string; participantId: string; messageId: string }): MessageView {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: false,
      });
      const row = this.requireMessage(args.groupId, args.messageId);
      return buildMessageViews([row], args.participantId, this.messagesRepo)[0];
    });
  }

  /** 历史查询：按 after_seq 顺序分页，包含自身消息与系统消息，不改变读取进度 */
  list(args: {
    groupId: string;
    participantId: string;
    afterSeq?: number;
    limit?: number;
  }): { messages: MessageView[]; next_seq: number; has_more: boolean } {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: false,
      });
      const afterSeq = args.afterSeq ?? 0;
      const limit = this.normalizeLimit(args.limit);
      return this.pageResult(
        this.messagesRepo.listAfterSeq(args.groupId, afterSeq, limit + 1),
        afterSeq,
        limit,
        args.participantId,
      );
    });
  }

  /** 直接回复查询：只匹配 reply_to_message_id */
  replies(args: {
    groupId: string;
    participantId: string;
    messageId: string;
    afterSeq?: number;
    limit?: number;
  }): { messages: MessageView[]; next_seq: number; has_more: boolean } {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: false,
      });
      const target = this.requireNormalMessage(args.groupId, args.messageId);
      const afterSeq = args.afterSeq ?? 0;
      const limit = this.normalizeLimit(args.limit);
      return this.pageResult(
        this.messagesRepo.listReplies(args.groupId, target.messageId, afterSeq, limit + 1),
        afterSeq,
        limit,
        args.participantId,
      );
    });
  }

  /** 讨论查询：按 thread_root_message_id 返回整个讨论，包含根消息 */
  thread(args: {
    groupId: string;
    participantId: string;
    messageId: string;
    afterSeq?: number;
    limit?: number;
  }): { messages: MessageView[]; next_seq: number; has_more: boolean } {
    return this.db.tx(() => {
      requireMember(this.groupsRepo, this.participantsRepo, args.groupId, args.participantId, {
        activeGroup: false,
      });
      const target = this.requireNormalMessage(args.groupId, args.messageId);
      const rootId = target.threadRootMessageId ?? target.messageId;
      const afterSeq = args.afterSeq ?? 0;
      const limit = this.normalizeLimit(args.limit);
      return this.pageResult(
        this.messagesRepo.listThread(args.groupId, rootId, afterSeq, limit + 1),
        afterSeq,
        limit,
        args.participantId,
      );
    });
  }

  private requireMessage(groupId: string, messageId: string): MessageRow {
    const row = this.messagesRepo.findByIdInGroup(messageId, groupId);
    if (!row) {
      throw new BusinessError('MESSAGE_NOT_FOUND', '消息不存在或不属于该组', {
        group_id: groupId,
        message_id: messageId,
      });
    }
    return row;
  }

  private requireNormalMessage(groupId: string, messageId: string): MessageRow {
    const row = this.requireMessage(groupId, messageId);
    if (row.type !== 'message') {
      throw new BusinessError('INVALID_REPLY_TARGET', '目标必须是普通消息', {
        message_id: messageId,
        type: row.type,
      });
    }
    return row;
  }

  private pageResult(
    rows: MessageRow[],
    afterSeq: number,
    limit: number,
    viewerParticipantId: string,
  ): { messages: MessageView[]; next_seq: number; has_more: boolean } {
    const page = rows.slice(0, limit);
    const hasMore = rows.length > limit;
    const nextSeq = page.length > 0 ? page[page.length - 1].seq : afterSeq;
    return {
      messages: buildMessageViews(page, viewerParticipantId, this.messagesRepo),
      next_seq: nextSeq,
      has_more: hasMore,
    };
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
