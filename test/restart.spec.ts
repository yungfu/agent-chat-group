import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { call, makeClient, startApp, tempDbDir, TestApp } from './helpers';

const dbDir = tempDbDir('chatgroup-restart-');
const dbPath = join(dbDir, 'restart.db');

let app: TestApp;
let client: Client;

// 第一阶段的状态（重启后仍需可用）
let groupId: string;
let participantId: string;
let unreadMessageId: string;
let readReceipt: string | null = null;
let boardKeyVersion = 0;

describe('服务重启后的持久化（设计 §13）', () => {
  beforeAll(async () => {
    app = await startApp(dbPath);
    client = await makeClient(app.port);

    // 准备数据：组、参与者、未读消息（未 ack）、board 条目
    const { group } = await call(client, 'group.create', { name: '重启持久化' });
    groupId = group.group_id;
    const joined = await call(client, 'group.join', {
      group_id: groupId,
      display_name: 'WSL 会话',
      declaration: '负责修改代码',
    });
    participantId = joined.self.participant_id;

    // 第二个成员发一条 A 未读的消息
    const joinB = await call(client, 'group.join', { group_id: groupId, display_name: '桌面验证' });
    const sent = await call(client, 'message.send', {
      group_id: groupId,
      participant_id: joinB.self.participant_id,
      text: '重启前的未读消息',
    });
    unreadMessageId = sent.message.message_id;

    // 读取但故意不确认：read 响应丢失不应导致消息被标记已读
    const read = await call(client, 'message.read', { group_id: groupId, participant_id: participantId });
    expect(read.messages.map((m: any) => m.message_id)).toContain(unreadMessageId);
    readReceipt = read.read_receipt;

    const entry = await call(client, 'board.put', {
      group_id: groupId,
      participant_id: participantId,
      key: 'progress/wsl',
      value: { summary: '修改完成', revision: 'abc123' },
      expected_version: 0,
    });
    boardKeyVersion = entry.entry.version;

    // 关闭服务（模拟重启）
    await client.close();
    await app.app.close();
  });

  it('重启后原参与者 ID、读取进度与回执仍可用', async () => {
    app = await startApp(dbPath);
    client = await makeClient(app.port);

    // 组与成员仍在
    const detail = await call(client, 'group.get', { group_id: groupId });
    expect(detail.group.group_id).toBe(groupId);
    expect(detail.participants.some((p: any) => p.participant_id === participantId)).toBe(true);

    // 读取进度未推进：未读消息仍返回（read 响应丢失不会自动标记已读）
    const read = await call(client, 'message.read', { group_id: groupId, participant_id: participantId });
    expect(read.messages.map((m: any) => m.message_id)).toContain(unreadMessageId);

    // 重启前的回执仍可确认
    expect(readReceipt).toBeTruthy();
    const ack = await call(client, 'message.ack', {
      group_id: groupId,
      participant_id: participantId,
      read_receipt: readReceipt,
    });
    expect(ack.last_read_seq).toBeGreaterThan(0);

    // 确认后未读清空
    const readAfter = await call(client, 'message.read', { group_id: groupId, participant_id: participantId });
    expect(readAfter.messages).toEqual([]);
    expect(readAfter.read_receipt).toBeNull();

    // board 条目与版本仍在
    const entry = await call(client, 'board.get', {
      group_id: groupId,
      participant_id: participantId,
      key: 'progress/wsl',
    });
    expect(entry.entry.version).toBe(boardKeyVersion);
    expect(entry.entry.value).toEqual({ summary: '修改完成', revision: 'abc123' });
  });
});

afterAll(async () => {
  await client?.close();
  await app?.app.close();
});
