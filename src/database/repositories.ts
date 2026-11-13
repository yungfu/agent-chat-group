import { Injectable } from '@nestjs/common';
import { DatabaseService, SqlParam } from './database.service';

/* ------------------------------ 领域行类型 ------------------------------ */

export type GroupStatus = 'active' | 'closed';

export interface Group {
  groupId: string;
  name: string;
  description: string;
  status: GroupStatus;
  lastSeq: number;
  createdAt: string;
  closedAt: string | null;
}

export interface Participant {
  participantId: string;
  groupId: string;
  displayName: string;
  declaration: string;
  lastReadSeq: number;
  joinedAt: string;
  leftAt: string | null;
}

export type SystemMessageType =
  | 'participant.joined'
  | 'participant.updated'
  | 'participant.left'
  | 'group.closed';

export type MessageType = 'message' | SystemMessageType;

export interface MessageRow {
  messageId: string;
  groupId: string;
  seq: number;
  type: MessageType;
  senderId: string | null;
  actorParticipantId: string | null;
  text: string;
  payloadJson: string | null;
  replyToMessageId: string | null;
  threadRootMessageId: string | null;
  createdAt: string;
}

export interface ReadReceiptRow {
  id: string;
  groupId: string;
  participantId: string;
  fromSeq: number;
  throughSeq: number;
  createdAt: string;
}

export interface BoardEntryRow {
  groupId: string;
  key: string;
  valueJson: string | null;
  version: number;
  updatedBy: string;
  updatedAt: string;
  deletedAt: string | null;
}

/* ------------------------------ 映射助手 ------------------------------ */

const asString = (value: unknown): string => String(value);
const asNullableString = (value: unknown): string | null => (value == null ? null : String(value));
const asNumber = (value: unknown): number => Number(value);

/* ------------------------------ 聊天组 ------------------------------ */

@Injectable()
export class GroupsRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(group: Group): void {
    this.db.run(
      `INSERT INTO groups (id, name, description, status, last_seq, created_at, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      group.groupId,
      group.name,
      group.description,
      group.status,
      group.lastSeq,
      group.createdAt,
      group.closedAt,
    );
  }

  findById(groupId: string): Group | undefined {
    const row = this.db.get('SELECT * FROM groups WHERE id = ?', groupId);
    return row ? mapGroup(row) : undefined;
  }

  /** 原子分配组内下一个 seq：UPDATE ... RETURNING，必须处于写事务内 */
  bumpSeq(groupId: string): number | undefined {
    const row = this.db.get(
      'UPDATE groups SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq',
      groupId,
    );
    return row ? asNumber(row.last_seq) : undefined;
  }

  close(groupId: string, closedAt: string): void {
    this.db.run(
      `UPDATE groups SET status = 'closed', closed_at = ? WHERE id = ?`,
      closedAt,
      groupId,
    );
  }

  delete(groupId: string): void {
    this.db.run('DELETE FROM groups WHERE id = ?', groupId);
  }

  /** 销毁组时按依赖顺序清理全部关联记录（配合 defer_foreign_keys 双保险） */
  deleteGroupCascade(groupId: string): void {
    this.db.run(
      'DELETE FROM message_mentions WHERE message_id IN (SELECT id FROM messages WHERE group_id = ?)',
      groupId,
    );
    this.db.run('DELETE FROM messages WHERE group_id = ?', groupId);
    this.db.run('DELETE FROM read_receipts WHERE group_id = ?', groupId);
    this.db.run('DELETE FROM board_entries WHERE group_id = ?', groupId);
    this.db.run('DELETE FROM participants WHERE group_id = ?', groupId);
    this.db.run('DELETE FROM groups WHERE id = ?', groupId);
  }

  /** 按 rowid（创建顺序）游标分页；afterRowid 传 0 表示从头开始 */
  listAfterRowid(afterRowid: number, limit: number): { groups: Group[]; lastRowid: number } {
    const rows = this.db.all(
      'SELECT rowid AS _rowid_, * FROM groups WHERE rowid > ? ORDER BY rowid ASC LIMIT ?',
      afterRowid,
      limit,
    );
    const groups = rows.map(mapGroup);
    const lastRowid = rows.length ? asNumber(rows[rows.length - 1]._rowid_) : afterRowid;
    return { groups, lastRowid };
  }
}

function mapGroup(row: Record<string, unknown>): Group {
  return {
    groupId: asString(row.id),
    name: asString(row.name),
    description: asString(row.description),
    status: asString(row.status) as GroupStatus,
    lastSeq: asNumber(row.last_seq),
    createdAt: asString(row.created_at),
    closedAt: asNullableString(row.closed_at),
  };
}

/* ------------------------------ 参与者 ------------------------------ */

@Injectable()
export class ParticipantsRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(participant: Participant): void {
    this.db.run(
      `INSERT INTO participants (id, group_id, display_name, declaration, last_read_seq, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      participant.participantId,
      participant.groupId,
      participant.displayName,
      participant.declaration,
      participant.lastReadSeq,
      participant.joinedAt,
      participant.leftAt,
    );
  }

  findByIdInGroup(participantId: string, groupId: string): Participant | undefined {
    const row = this.db.get(
      'SELECT * FROM participants WHERE id = ? AND group_id = ?',
      participantId,
      groupId,
    );
    return row ? mapParticipant(row) : undefined;
  }

  /** 全部成员（含已退出），按加入顺序 */
  listByGroup(groupId: string): Participant[] {
    return this.db
      .all('SELECT * FROM participants WHERE group_id = ? ORDER BY joined_at, id', groupId)
      .map(mapParticipant);
  }

  listActive(groupId: string): Participant[] {
    return this.db
      .all(
        'SELECT * FROM participants WHERE group_id = ? AND left_at IS NULL ORDER BY joined_at, id',
        groupId,
      )
      .map(mapParticipant);
  }

  updateProfile(participantId: string, displayName: string, declaration: string): void {
    this.db.run(
      'UPDATE participants SET display_name = ?, declaration = ? WHERE id = ?',
      displayName,
      declaration,
      participantId,
    );
  }

  markLeft(participantId: string, leftAt: string): void {
    this.db.run('UPDATE participants SET left_at = ? WHERE id = ?', leftAt, participantId);
  }

  /** 只前进不后退：last_read_seq = MAX(last_read_seq, seq) */
  raiseLastRead(participantId: string, seq: number): void {
    this.db.run(
      'UPDATE participants SET last_read_seq = MAX(last_read_seq, ?) WHERE id = ?',
      seq,
      participantId,
    );
  }
}

function mapParticipant(row: Record<string, unknown>): Participant {
  return {
    participantId: asString(row.id),
    groupId: asString(row.group_id),
    displayName: asString(row.display_name),
    declaration: asString(row.declaration),
    lastReadSeq: asNumber(row.last_read_seq),
    joinedAt: asString(row.joined_at),
    leftAt: asNullableString(row.left_at),
  };
}

/* ------------------------------ 消息 / 回执 ------------------------------ */

@Injectable()
export class MessagesRepository {
  constructor(private readonly db: DatabaseService) {}

  insert(row: MessageRow): void {
    this.db.run(
      `INSERT INTO messages
         (id, group_id, seq, type, sender_id, actor_participant_id, text, payload_json,
          reply_to_message_id, thread_root_message_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.messageId,
      row.groupId,
      row.seq,
      row.type,
      row.senderId,
      row.actorParticipantId,
      row.text,
      row.payloadJson,
      row.replyToMessageId,
      row.threadRootMessageId,
      row.createdAt,
    );
  }

  insertMentions(messageId: string, participantIds: string[]): void {
    for (const participantId of participantIds) {
      this.db.run(
        'INSERT INTO message_mentions (message_id, participant_id) VALUES (?, ?)',
        messageId,
        participantId,
      );
    }
  }

  findByIdInGroup(messageId: string, groupId: string): MessageRow | undefined {
    const row = this.db.get(
      'SELECT * FROM messages WHERE id = ? AND group_id = ?',
      messageId,
      groupId,
    );
    return row ? mapMessage(row) : undefined;
  }

  /** seq > afterSeq 的流记录，升序，含系统消息 */
  listAfterSeq(groupId: string, afterSeq: number, limit: number): MessageRow[] {
    return this.db
      .all(
        'SELECT * FROM messages WHERE group_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?',
        groupId,
        afterSeq,
        limit,
      )
      .map(mapMessage);
  }

  listReplies(groupId: string, targetMessageId: string, afterSeq: number, limit: number): MessageRow[] {
    return this.db
      .all(
        `SELECT * FROM messages
         WHERE group_id = ? AND reply_to_message_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
        groupId,
        targetMessageId,
        afterSeq,
        limit,
      )
      .map(mapMessage);
  }

  listThread(groupId: string, rootMessageId: string, afterSeq: number, limit: number): MessageRow[] {
    return this.db
      .all(
        `SELECT * FROM messages
         WHERE group_id = ? AND thread_root_message_id = ? AND seq > ?
         ORDER BY seq ASC LIMIT ?`,
        groupId,
        rootMessageId,
        afterSeq,
        limit,
      )
      .map(mapMessage);
  }

  findManyById(ids: string[]): Map<string, MessageRow> {
    const result = new Map<string, MessageRow>();
    if (ids.length === 0) return result;
    const chunkSize = 100;
    for (let i = 0; i < ids.length; i += chunkSize) {
      const chunk = ids.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db.all(
        `SELECT * FROM messages WHERE id IN (${placeholders})`,
        ...chunk,
      );
      for (const row of rows) {
        const message = mapMessage(row);
        result.set(message.messageId, message);
      }
    }
    return result;
  }

  /** 批量取消息的 mentions，保持插入顺序 */
  mentionsForMessages(messageIds: string[]): Map<string, string[]> {
    const result = new Map<string, string[]>();
    if (messageIds.length === 0) return result;
    const chunkSize = 100;
    for (let i = 0; i < messageIds.length; i += chunkSize) {
      const chunk = messageIds.slice(i, i + chunkSize);
      const placeholders = chunk.map(() => '?').join(', ');
      const rows = this.db.all(
        `SELECT message_id, participant_id FROM message_mentions
         WHERE message_id IN (${placeholders}) ORDER BY rowid`,
        ...chunk,
      );
      for (const row of rows) {
        const messageId = asString(row.message_id);
        const list = result.get(messageId) ?? [];
        list.push(asString(row.participant_id));
        result.set(messageId, list);
      }
    }
    return result;
  }

  insertReceipt(receipt: ReadReceiptRow): void {
    this.db.run(
      `INSERT INTO read_receipts (id, group_id, participant_id, from_seq, through_seq, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      receipt.id,
      receipt.groupId,
      receipt.participantId,
      receipt.fromSeq,
      receipt.throughSeq,
      receipt.createdAt,
    );
  }

  findReceiptById(receiptId: string): ReadReceiptRow | undefined {
    const row = this.db.get('SELECT * FROM read_receipts WHERE id = ?', receiptId);
    return row ? mapReceipt(row) : undefined;
  }
}

function mapMessage(row: Record<string, unknown>): MessageRow {
  return {
    messageId: asString(row.id),
    groupId: asString(row.group_id),
    seq: asNumber(row.seq),
    type: asString(row.type) as MessageType,
    senderId: asNullableString(row.sender_id),
    actorParticipantId: asNullableString(row.actor_participant_id),
    text: asString(row.text),
    payloadJson: asNullableString(row.payload_json),
    replyToMessageId: asNullableString(row.reply_to_message_id),
    threadRootMessageId: asNullableString(row.thread_root_message_id),
    createdAt: asString(row.created_at),
  };
}

function mapReceipt(row: Record<string, unknown>): ReadReceiptRow {
  return {
    id: asString(row.id),
    groupId: asString(row.group_id),
    participantId: asString(row.participant_id),
    fromSeq: asNumber(row.from_seq),
    throughSeq: asNumber(row.through_seq),
    createdAt: asString(row.created_at),
  };
}

/* ------------------------------ Board ------------------------------ */

@Injectable()
export class BoardRepository {
  constructor(private readonly db: DatabaseService) {}

  find(groupId: string, key: string): BoardEntryRow | undefined {
    const row = this.db.get(
      'SELECT * FROM board_entries WHERE group_id = ? AND key = ?',
      groupId,
      key,
    );
    return row ? mapBoardEntry(row) : undefined;
  }

  insert(entry: BoardEntryRow): void {
    this.db.run(
      `INSERT INTO board_entries (group_id, key, value_json, version, updated_by, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      entry.groupId,
      entry.key,
      entry.valueJson,
      entry.version,
      entry.updatedBy,
      entry.updatedAt,
      entry.deletedAt,
    );
  }

  /** 带版本条件的更新：创建后 version = expectedVersion + 1；命中墓碑则同时复活 */
  updateWithVersion(
    groupId: string,
    key: string,
    valueJson: string,
    expectedVersion: number,
    updatedBy: string,
    updatedAt: string,
  ): { changes: number } {
    return this.db.run(
      `UPDATE board_entries
       SET value_json = ?, version = version + 1, updated_by = ?, updated_at = ?, deleted_at = NULL
       WHERE group_id = ? AND key = ? AND version = ?`,
      valueJson,
      updatedBy,
      updatedAt,
      groupId,
      key,
      expectedVersion,
    );
  }

  /** 带版本条件的删除：保留墓碑并递增版本 */
  markDeleted(groupId: string, key: string, expectedVersion: number, deletedAt: string): { changes: number } {
    return this.db.run(
      `UPDATE board_entries
       SET version = version + 1, deleted_at = ?
       WHERE group_id = ? AND key = ? AND version = ? AND deleted_at IS NULL`,
      deletedAt,
      groupId,
      key,
      expectedVersion,
    );
  }

  /** 按键名升序、隐藏墓碑的游标分页 */
  listAfterKey(groupId: string, afterKey: string | null, limit: number): BoardEntryRow[] {
    const params: SqlParam[] = [groupId];
    let condition = 'group_id = ? AND deleted_at IS NULL';
    if (afterKey !== null) {
      condition += ' AND key > ?';
      params.push(afterKey);
    }
    params.push(limit);
    return this.db
      .all(`SELECT * FROM board_entries WHERE ${condition} ORDER BY key ASC LIMIT ?`, ...params)
      .map(mapBoardEntry);
  }
}

function mapBoardEntry(row: Record<string, unknown>): BoardEntryRow {
  return {
    groupId: asString(row.group_id),
    key: asString(row.key),
    valueJson: asNullableString(row.value_json),
    version: asNumber(row.version),
    updatedBy: asString(row.updated_by),
    updatedAt: asString(row.updated_at),
    deletedAt: asNullableString(row.deleted_at),
  };
}
