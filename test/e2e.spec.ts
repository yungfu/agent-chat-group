import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { call, callExpectError, makeClient, startApp, tempDbDir, TestApp } from './helpers';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

let app: TestApp;
let wsl: Client; // 模拟 WSL 中的会话
let desktop: Client; // 模拟 Windows 桌面的会话

const dbDir = tempDbDir();

beforeAll(async () => {
  app = await startApp(join(dbDir, 'main.db'));
  wsl = await makeClient(app.port);
  desktop = await makeClient(app.port);
});

afterAll(async () => {
  await wsl.close();
  await desktop.close();
  await app.app.close();
});

/** 建一个双人组，返回成员参数 */
async function newPair(name: string): Promise<{
  groupId: string;
  a: string;
  b: string;
}> {
  const { group } = await call(wsl, 'group.create', { name, description: 'e2e' });
  const joinA = await call(wsl, 'group.join', {
    group_id: group.group_id,
    display_name: 'WSL 会话',
    declaration: '负责修改代码',
  });
  const joinB = await call(desktop, 'group.join', {
    group_id: group.group_id,
    display_name: '桌面浏览器验证',
    declaration: '可以执行浏览器验证并提供截图链接',
  });
  return { groupId: group.group_id, a: joinA.self.participant_id, b: joinB.self.participant_id };
}

describe('典型协作流程（设计 §12）', () => {
  it('两个客户端加入同组，使用统一消息 ID 相互回复', async () => {
    const { groupId, a, b } = await newPair('协作流程');

    // WSL 发送 @ 桌面 的验证请求
    const request = await call(wsl, 'message.send', {
      group_id: groupId,
      participant_id: a,
      text: '请验证登录功能，版本 abc123',
      mentions: [b],
    });
    expect(request.message.seq).toBeGreaterThan(0);
    expect(request.message.mentions).toEqual([b]);
    expect(request.message.thread_root_message_id).toBe(request.message.message_id);

    // 桌面主动 read：能看到 @ 自己的消息，且响应包含派生字段
    const read1 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    const got = read1.messages.filter((m: any) => m.type === 'message');
    expect(got).toHaveLength(1);
    expect(got[0].message_id).toBe(request.message.message_id);
    expect(got[0].is_mentioned).toBe(true);
    expect(got[0].is_reply_to_me).toBe(false);
    expect(read1.read_receipt).toBeTruthy();
    expect(read1.has_more).toBe(false);

    // read 不推进位置：再次读取返回相同消息
    const read2 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    expect(read2.messages.map((m: any) => m.message_id)).toContain(request.message.message_id);

    // 确认接收后不再返回
    const ack = await call(desktop, 'message.ack', {
      group_id: groupId,
      participant_id: b,
      read_receipt: read1.read_receipt,
    });
    expect(ack.last_read_seq).toBeGreaterThanOrEqual(request.message.seq);
    const read3 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    expect(read3.messages).toEqual([]);
    expect(read3.read_receipt).toBeNull();
    expect(read3.has_more).toBe(false);

    // 桌面回复并引用原请求消息 ID
    const reply = await call(desktop, 'message.send', {
      group_id: groupId,
      participant_id: b,
      text: '验证完成，登录正常',
      reply_to_message_id: request.message.message_id,
    });
    expect(reply.message.reply_to_message_id).toBe(request.message.message_id);
    expect(reply.message.reply_to_sender_id).toBe(a);
    expect(reply.message.thread_root_message_id).toBe(request.message.message_id);
    expect(reply.message.reply_preview.message_id).toBe(request.message.message_id);

    // WSL 读取：看到回复，且 is_reply_to_me 为真
    const readA = await call(wsl, 'message.read', { group_id: groupId, participant_id: a });
    const replyView = readA.messages.find((m: any) => m.message_id === reply.message.message_id);
    expect(replyView).toBeDefined();
    expect(replyView.is_reply_to_me).toBe(true);
    expect(replyView.is_mentioned).toBe(false);

    // WSL 查询原请求的 replies 与整个讨论
    const replies = await call(wsl, 'message.replies', {
      group_id: groupId,
      participant_id: a,
      message_id: request.message.message_id,
    });
    expect(replies.messages.map((m: any) => m.message_id)).toEqual([reply.message.message_id]);
    const thread = await call(wsl, 'message.thread', {
      group_id: groupId,
      participant_id: a,
      message_id: reply.message.message_id,
    });
    expect(thread.messages.map((m: any) => m.seq)).toEqual([request.message.seq, reply.message.seq]);
  });

  it('多级回复的讨论根一致，replies 只匹配直接回复', async () => {
    const { groupId, a, b } = await newPair('多级讨论');
    const root = await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: '根消息' });
    const r1 = await call(desktop, 'message.send', {
      group_id: groupId,
      participant_id: b,
      text: '一级回复',
      reply_to_message_id: root.message.message_id,
    });
    const r2 = await call(wsl, 'message.send', {
      group_id: groupId,
      participant_id: a,
      text: '二级回复',
      reply_to_message_id: r1.message.message_id,
    });
    expect(r2.message.thread_root_message_id).toBe(root.message.message_id);

    const thread = await call(wsl, 'message.thread', {
      group_id: groupId,
      participant_id: a,
      message_id: r2.message.message_id,
    });
    expect(thread.messages.map((m: any) => m.message_id)).toEqual([
      root.message.message_id,
      r1.message.message_id,
      r2.message.message_id,
    ]);
    const rootReplies = await call(wsl, 'message.replies', {
      group_id: groupId,
      participant_id: a,
      message_id: root.message.message_id,
    });
    expect(rootReplies.messages.map((m: any) => m.message_id)).toEqual([r1.message.message_id]);
  });
});

describe('读取与确认语义（设计 §6）', () => {
  it('跳过自身消息：返回为空但回执前进', async () => {
    const { groupId, a } = await newPair('自身消息跳过');
    // 先把加入阶段的消息全部读净
    const warmup = await call(wsl, 'message.read', { group_id: groupId, participant_id: a });
    await call(wsl, 'message.ack', { group_id: groupId, participant_id: a, read_receipt: warmup.read_receipt });

    // 自己发一条消息：read 扫描到它但跳过返回
    const sent = await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: '我自己的消息' });
    const read = await call(wsl, 'message.read', { group_id: groupId, participant_id: a });
    expect(read.messages).toEqual([]); // 自身普通消息被跳过，返回为空
    expect(read.read_receipt).toBeTruthy(); // 扫描位置前进，仍签发可确认的回执
    expect(read.has_more).toBe(false);
    const ack = await call(wsl, 'message.ack', { group_id: groupId, participant_id: a, read_receipt: read.read_receipt });
    expect(ack.last_read_seq).toBe(sent.message.seq);

    // 自身作为 actor 的系统消息（如他人加入）不会被跳过
    await call(desktop, 'group.join', { group_id: groupId, display_name: '新成员' });
    const read2 = await call(wsl, 'message.read', { group_id: groupId, participant_id: a });
    expect(read2.messages.every((m: any) => m.type !== 'message')).toBe(true);
    expect(read2.messages.some((m: any) => m.type === 'participant.joined')).toBe(true);
  });

  it('limit 控制扫描的流记录数，has_more 与分页边界正确', async () => {
    const { groupId, a, b } = await newPair('分页');
    // 消息流：seq1=A 加入系统消息，seq2=B 加入系统消息；再发 3 条普通消息（seq3-5）
    for (let i = 1; i <= 3; i += 1) {
      await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: `消息 ${i}` });
    }
    // B 加入时 last_read_seq=1：第一页扫描 seq2-3（含 B 自己加入的系统消息 + 消息1）
    const page1 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b, limit: 2 });
    expect(page1.messages.map((m: any) => m.seq)).toEqual([2, 3]);
    expect(page1.has_more).toBe(true);
    await call(desktop, 'message.ack', { group_id: groupId, participant_id: b, read_receipt: page1.read_receipt });
    const page2 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b, limit: 2 });
    expect(page2.messages.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(page2.has_more).toBe(false);

    // message.list 分页：next_seq 与 has_more
    const list1 = await call(desktop, 'message.list', { group_id: groupId, participant_id: b, limit: 3 });
    expect(list1.messages.map((m: any) => m.seq)).toEqual([1, 2, 3]);
    expect(list1.has_more).toBe(true);
    expect(list1.next_seq).toBe(3);
    const list2 = await call(desktop, 'message.list', {
      group_id: groupId,
      participant_id: b,
      after_seq: list1.next_seq,
      limit: 3,
    });
    expect(list2.messages.map((m: any) => m.seq)).toEqual([4, 5]);
    expect(list2.has_more).toBe(false);
    expect(list2.next_seq).toBe(5);
  });

  it('重复 ack 安全，旧回执不能让进度倒退', async () => {
    const { groupId, a, b } = await newPair('回执语义');
    await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: '第一批' });
    const read1 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    const ack1 = await call(desktop, 'message.ack', { group_id: groupId, participant_id: b, read_receipt: read1.read_receipt });
    // 重复 ack 幂等
    const ack1b = await call(desktop, 'message.ack', { group_id: groupId, participant_id: b, read_receipt: read1.read_receipt });
    expect(ack1b.last_read_seq).toBe(ack1.last_read_seq);

    await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: '第二批' });
    const read2 = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    const ack2 = await call(desktop, 'message.ack', { group_id: groupId, participant_id: b, read_receipt: read2.read_receipt });
    expect(ack2.last_read_seq).toBeGreaterThan(ack1.last_read_seq);
    // 旧回执再次确认：进度不倒退
    const ackOld = await call(desktop, 'message.ack', { group_id: groupId, participant_id: b, read_receipt: read1.read_receipt });
    expect(ackOld.last_read_seq).toBe(ack2.last_read_seq);
  });

  it('错误参与者使用他人回执被拒绝', async () => {
    const { groupId, a, b } = await newPair('回执绑定');
    await call(desktop, 'message.send', { group_id: groupId, participant_id: b, text: '给 A 的消息' });
    const readB = await call(desktop, 'message.read', { group_id: groupId, participant_id: b });
    // B 读到的是自己的消息（被跳过），但回执属于 B；A 拿 B 的回执确认应失败
    const err = await callExpectError(wsl, 'message.ack', {
      group_id: groupId,
      participant_id: a,
      read_receipt: readB.read_receipt ?? 'rr_x',
    });
    expect(err.code).toBe('INVALID_READ_RECEIPT');
    const errFake = await callExpectError(wsl, 'message.ack', {
      group_id: groupId,
      participant_id: a,
      read_receipt: 'rr_不存在的回执',
    });
    expect(errFake.code).toBe('INVALID_READ_RECEIPT');
  });

  it('加入时不把加入前历史当作未读，加入后消息不漏', async () => {
    const { group } = await call(wsl, 'group.create', { name: '加入边界' });
    const joinA = await call(wsl, 'group.join', { group_id: group.group_id, display_name: 'A' });
    const a = joinA.self.participant_id;
    const before = await call(wsl, 'message.send', { group_id: group.group_id, participant_id: a, text: '加入前的消息' });

    const joinB = await call(desktop, 'group.join', { group_id: group.group_id, display_name: 'B' });
    const b = joinB.self.participant_id;
    // B 的 last_read_seq 覆盖了 before
    expect(joinB.self.last_read_seq).toBe(before.message.seq);

    const after = await call(wsl, 'message.send', { group_id: group.group_id, participant_id: a, text: '加入后的消息' });
    const read = await call(desktop, 'message.read', { group_id: group.group_id, participant_id: b });
    const ids = read.messages.map((m: any) => m.message_id);
    expect(ids).not.toContain(before.message.message_id); // 加入前历史不算未读
    expect(ids).toContain(after.message.message_id); // 加入后的消息不漏
    // 历史接口仍可查到全部
    const list = await call(desktop, 'message.list', { group_id: group.group_id, participant_id: b });
    expect(list.messages.map((m: any) => m.message_id)).toContain(before.message.message_id);
  });

  it('非法 limit 被拒绝', async () => {
    const { groupId, a } = await newPair('limit 校验');
    for (const limit of [0, 101, 1.5]) {
      const err = await callExpectError(wsl, 'message.read', { group_id: groupId, participant_id: a, limit });
      expect(err.code).toBe('INVALID_ARGUMENT');
    }
  });
});

describe('消息发送并发与校验（设计 §5、§11）', () => {
  it('并发发送的组内 seq 不重复', async () => {
    const { groupId, a, b } = await newPair('并发 seq');
    const count = 20;
    const results = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        call(i % 2 === 0 ? wsl : desktop, 'message.send', {
          group_id: groupId,
          participant_id: i % 2 === 0 ? a : b,
          text: `并发消息 ${i}`,
        }),
      ),
    );
    const seqs = results.map((r: any) => r.message.seq);
    expect(new Set(seqs).size).toBe(count);
    const list = await call(wsl, 'message.list', { group_id: groupId, participant_id: a, limit: 100 });
    const allSeqs = list.messages.map((m: any) => m.seq);
    expect(allSeqs).toEqual([...allSeqs].sort((x: number, y: number) => x - y)); // 升序
  });

  it('mentions 必须是本组当前活跃成员', async () => {
    const { groupId, a } = await newPair('mention 校验');
    const { group: other } = await call(wsl, 'group.create', { name: '另一个组' });
    const otherJoin = await call(wsl, 'group.join', { group_id: other.group_id, display_name: '外人' });

    const err1 = await callExpectError(wsl, 'message.send', {
      group_id: groupId, participant_id: a, text: 'hi', mentions: [otherJoin.self.participant_id],
    });
    expect(err1.code).toBe('INVALID_MENTION');

    const err2 = await callExpectError(wsl, 'message.send', {
      group_id: groupId, participant_id: a, text: 'hi', mentions: ['p_不存在'],
    });
    expect(err2.code).toBe('INVALID_MENTION');
  });

  it('跨组回复与回复系统消息被拒绝', async () => {
    const { groupId, a } = await newPair('回复校验');
    const { group: other } = await call(wsl, 'group.create', { name: '其他组' });
    const otherJoin = await call(wsl, 'group.join', { group_id: other.group_id, display_name: '外人' });
    const otherMsg = await call(wsl, 'message.send', {
      group_id: other.group_id, participant_id: otherJoin.self.participant_id, text: '别组的消息',
    });

    const errCross = await callExpectError(wsl, 'message.send', {
      group_id: groupId, participant_id: a, text: '回复别组', reply_to_message_id: otherMsg.message.message_id,
    });
    expect(errCross.code).toBe('MESSAGE_NOT_FOUND');

    // 找一条系统消息回复
    const list = await call(wsl, 'message.list', { group_id: groupId, participant_id: a });
    const sysMsg = list.messages.find((m: any) => m.type !== 'message');
    const errSys = await callExpectError(wsl, 'message.send', {
      group_id: groupId, participant_id: a, text: '回复系统消息', reply_to_message_id: sysMsg.message_id,
    });
    expect(errSys.code).toBe('INVALID_REPLY_TARGET');

    // 已退出成员留下的历史消息可以被回复
    const { groupId: g2, a: a2, b: b2 } = await newPair('回复已退出成员');
    const legacy = await call(desktop, 'message.send', { group_id: g2, participant_id: b2, text: '退出前的消息' });
    await call(desktop, 'participant.leave', { group_id: g2, participant_id: b2 });
    const reply = await call(wsl, 'message.send', {
      group_id: g2, participant_id: a2, text: '回复已退出成员', reply_to_message_id: legacy.message.message_id,
    });
    expect(reply.message.reply_to_sender_id).toBe(b2);
  });

  it('非成员与已退出参与者不能操作', async () => {
    const { groupId, a } = await newPair('成员校验');
    const err = await callExpectError(wsl, 'message.send', {
      group_id: groupId, participant_id: 'p_不属于本组', text: 'hi',
    });
    expect(err.code).toBe('PARTICIPANT_NOT_FOUND');

    const { groupId: g2, a: a2 } = await newPair('退出校验');
    await call(wsl, 'participant.leave', { group_id: g2, participant_id: a2 });
    for (const [name, args] of [
      ['message.send', { group_id: g2, participant_id: a2, text: 'hi' }],
      ['message.read', { group_id: g2, participant_id: a2 }],
      ['board.put', { group_id: g2, participant_id: a2, key: 'k', value: 1, expected_version: 0 }],
    ] as const) {
      const e = await callExpectError(wsl, name as string, args as Record<string, unknown>);
      expect(e.code).toBe('PARTICIPANT_LEFT');
    }
    // 已退出身份保留在成员列表中用于历史引用
    const detail = await call(wsl, 'group.get', { group_id: g2 });
    const me = detail.participants.find((p: any) => p.participant_id === a2);
    expect(me.left_at).not.toBeNull();
  });

  it('participant.update 追加系统消息且至少需要一个字段', async () => {
    const { groupId, a } = await newPair('更新声明');
    const err = await callExpectError(wsl, 'participant.update', { group_id: groupId, participant_id: a });
    expect(err.code).toBe('INVALID_ARGUMENT');
    const updated = await call(wsl, 'participant.update', {
      group_id: groupId, participant_id: a, declaration: '新声明：负责代码与联调',
    });
    expect(updated.participant.declaration).toBe('新声明：负责代码与联调');
    const list = await call(wsl, 'message.list', { group_id: groupId, participant_id: a, limit: 100 });
    const sys = list.messages.filter((m: any) => m.type === 'participant.updated');
    expect(sys).toHaveLength(1);
    expect(sys[0].actor_participant_id).toBe(a);
    expect(sys[0].payload.declaration).toBe('新声明：负责代码与联调');
  });
});

describe('Board 版本并发（设计 §7）', () => {
  it('两个参与者同时更新，只有版本匹配的写入成功', async () => {
    const { groupId, a, b } = await newPair('board 并发');
    const created = await call(wsl, 'board.put', {
      group_id: groupId, participant_id: a, key: 'progress/overall', value: { status: 'started' }, expected_version: 0,
    });
    expect(created.entry.version).toBe(1);
    expect(created.entry.updated_by).toBe(a);

    const [r1, r2] = await Promise.all([
      call(wsl, 'board.put', {
        group_id: groupId, participant_id: a, key: 'progress/overall', value: { status: 'by-a' }, expected_version: 1,
      }),
      callExpectError(desktop, 'board.put', {
        group_id: groupId, participant_id: b, key: 'progress/overall', value: { status: 'by-b' }, expected_version: 1,
      }),
    ]);
    expect(r1.entry.version).toBe(2);
    expect(r2.code).toBe('VERSION_CONFLICT');
    expect(r2.details?.actual_version).toBe(2);

    const final = await call(desktop, 'board.get', { group_id: groupId, participant_id: b, key: 'progress/overall' });
    expect(final.entry.value).toEqual({ status: 'by-a' });
    expect(final.entry.version).toBe(2);
  });

  it('删除保留墓碑，重建必须携带墓碑版本且旧版本不再生效', async () => {
    const { groupId, a, b } = await newPair('board 墓碑');
    await call(wsl, 'board.put', { group_id: groupId, participant_id: a, key: 'env/info', value: { wsl: true }, expected_version: 0 });
    const del = await call(wsl, 'board.delete', { group_id: groupId, participant_id: a, key: 'env/info', expected_version: 1 });
    expect(del.version).toBe(2);
    expect(del.deleted).toBe(true);

    // get 返回 BOARD_ENTRY_DELETED 及墓碑版本
    const errGet = await callExpectError(desktop, 'board.get', { group_id: groupId, participant_id: b, key: 'env/info' });
    expect(errGet.code).toBe('BOARD_ENTRY_DELETED');
    expect(errGet.details?.version).toBe(2);

    // list 默认隐藏墓碑
    const listResult = await call(desktop, 'board.list', { group_id: groupId, participant_id: b });
    expect(listResult.entries.map((e: any) => e.key)).not.toContain('env/info');

    // expected_version=0 要求键从未存在：墓碑存在时拒绝
    const errCreate = await callExpectError(wsl, 'board.put', {
      group_id: groupId, participant_id: a, key: 'env/info', value: {}, expected_version: 0,
    });
    expect(errCreate.code).toBe('BOARD_ENTRY_DELETED');

    // 携带墓碑版本重建，版本继续递增；旧版本不再匹配
    const rebuilt = await call(desktop, 'board.put', {
      group_id: groupId, participant_id: b, key: 'env/info', value: { wsl: true, rebuilt: true }, expected_version: 2,
    });
    expect(rebuilt.entry.version).toBe(3);
    const errOld = await callExpectError(wsl, 'board.put', {
      group_id: groupId, participant_id: a, key: 'env/info', value: {}, expected_version: 1,
    });
    expect(errOld.code).toBe('VERSION_CONFLICT');

    const errDeleteOld = await callExpectError(wsl, 'board.delete', {
      group_id: groupId, participant_id: a, key: 'env/info', expected_version: 1,
    });
    expect(errDeleteOld.code).toBe('VERSION_CONFLICT');
    const errMissing = await callExpectError(wsl, 'board.delete', {
      group_id: groupId, participant_id: a, key: '不存在的键', expected_version: 1,
    });
    expect(errMissing.code).toBe('BOARD_ENTRY_NOT_FOUND');
  });

  it('board.list 按键名升序分页', async () => {
    const { groupId, a, b } = await newPair('board 分页');
    for (const key of ['a/one', 'b/two', 'c/three']) {
      await call(wsl, 'board.put', { group_id: groupId, participant_id: a, key, value: key, expected_version: 0 });
    }
    const page1 = await call(desktop, 'board.list', { group_id: groupId, participant_id: b, limit: 2 });
    expect(page1.entries.map((e: any) => e.key)).toEqual(['a/one', 'b/two']);
    expect(page1.next_cursor).toBeTruthy();
    const page2 = await call(desktop, 'board.list', {
      group_id: groupId, participant_id: b, limit: 2, cursor: page1.next_cursor,
    });
    expect(page2.entries.map((e: any) => e.key)).toEqual(['c/three']);
    expect(page2.next_cursor).toBeNull();
  });
});

describe('组生命周期（设计 §4）', () => {
  it('关闭后禁止写入与加入，允许读取与确认；重复关闭幂等', async () => {
    const { group } = await call(wsl, 'group.create', { name: '关闭语义' });
    const joinA = await call(wsl, 'group.join', { group_id: group.group_id, display_name: 'A' });
    const a = joinA.self.participant_id;
    const joinB = await call(desktop, 'group.join', { group_id: group.group_id, display_name: 'B' });
    const b = joinB.self.participant_id;
    await call(wsl, 'message.send', { group_id: group.group_id, participant_id: a, text: '关闭前的消息' });

    const closed = await call(wsl, 'group.close', { group_id: group.group_id });
    expect(closed.group.status).toBe('closed');
    expect(closed.group.closed_at).toBeTruthy();

    // 写入被拒绝
    const errSend = await callExpectError(wsl, 'message.send', { group_id: group.group_id, participant_id: a, text: 'x' });
    expect(errSend.code).toBe('GROUP_CLOSED');
    const errJoin = await callExpectError(desktop, 'group.join', { group_id: group.group_id, display_name: '迟到者' });
    expect(errJoin.code).toBe('GROUP_CLOSED');
    const errBoard = await callExpectError(wsl, 'board.put', {
      group_id: group.group_id, participant_id: a, key: 'k', value: 1, expected_version: 0,
    });
    expect(errBoard.code).toBe('GROUP_CLOSED');

    // 读取、查询与确认接收仍可用
    const read = await call(desktop, 'message.read', { group_id: group.group_id, participant_id: b });
    expect(read.messages.length).toBeGreaterThan(0);
    const ack = await call(desktop, 'message.ack', { group_id: group.group_id, participant_id: b, read_receipt: read.read_receipt });
    expect(ack.last_read_seq).toBeGreaterThan(0);
    const list = await call(desktop, 'message.list', { group_id: group.group_id, participant_id: b });
    expect(list.messages.length).toBeGreaterThan(0);

    // 重复关闭幂等，不重复追加系统消息
    const closed2 = await call(wsl, 'group.close', { group_id: group.group_id });
    expect(closed2.group.status).toBe('closed');
    const finalList = await call(desktop, 'message.list', { group_id: group.group_id, participant_id: b, limit: 100 });
    const closeEvents = finalList.messages.filter((m: any) => m.type === 'group.closed');
    expect(closeEvents).toHaveLength(1);
  });

  it('销毁后不存在可读取的孤立消息、board 或回执', async () => {
    const { groupId, a } = await newPair('销毁清理');
    await call(wsl, 'message.send', { group_id: groupId, participant_id: a, text: '待清理' });
    await call(wsl, 'board.put', { group_id: groupId, participant_id: a, key: 'k', value: 1, expected_version: 0 });
    const read = await call(wsl, 'message.read', { group_id: groupId, participant_id: a });

    const deleted = await call(wsl, 'group.delete', { group_id: groupId });
    expect(deleted.deleted).toBe(true);

    for (const [name, args] of [
      ['group.get', { group_id: groupId }],
      ['message.list', { group_id: groupId, participant_id: a }],
      ['message.read', { group_id: groupId, participant_id: a }],
      ['board.list', { group_id: groupId, participant_id: a }],
    ] as const) {
      const e = await callExpectError(wsl, name, args as Record<string, unknown>);
      expect(e.code).toBe('GROUP_NOT_FOUND');
    }
    // 悬空回执不可确认
    if (read.read_receipt) {
      const e = await callExpectError(wsl, 'message.ack', {
        group_id: 'grp_已销毁占位', participant_id: a, read_receipt: read.read_receipt,
      });
      expect(e.code).toBe('GROUP_NOT_FOUND');
    }
    const errAgain = await callExpectError(wsl, 'group.delete', { group_id: groupId });
    expect(errAgain.code).toBe('GROUP_NOT_FOUND');
  });

  it('group.list 分页且包含已关闭组', async () => {
    const { group: g1 } = await call(wsl, 'group.create', { name: '列表 A' });
    const { group: g2 } = await call(wsl, 'group.create', { name: '列表 B' });
    await call(wsl, 'group.close', { group_id: g1.group_id });

    // 游标分页：两页之间无重叠、无遗漏
    const page1 = await call(desktop, 'group.list', { limit: 2 });
    expect(page1.groups).toHaveLength(2);
    expect(page1.next_cursor).toBeTruthy();
    const page1Ids = page1.groups.map((g: any) => g.group_id);
    let rest = await call(desktop, 'group.list', { limit: 2, cursor: page1.next_cursor });
    while (true) {
      expect(rest.groups.map((g: any) => g.group_id).filter((id: string) => page1Ids.includes(id))).toEqual([]);
      if (!rest.next_cursor) break;
      rest = await call(desktop, 'group.list', { limit: 2, cursor: rest.next_cursor });
    }
    // 全量中能找到两个新组，且 g1 状态为 closed
    const all = await call(desktop, 'group.list', { limit: 100 });
    const found1 = all.groups.find((g: any) => g.group_id === g1.group_id);
    const found2 = all.groups.find((g: any) => g.group_id === g2.group_id);
    expect(found1?.status).toBe('closed');
    expect(found2?.status).toBe('active');
  });
});

describe('认证（设计 §3.1）', () => {
  it('错误 Token 的请求被拒绝（HTTP 401）', async () => {
    const badClient = await makeClient(app.port, 'wrong-token').catch((e) => e);
    if (badClient instanceof Error) {
      // 连接阶段即失败
      expect(String(badClient.message)).toBeTruthy();
      return;
    }
    await expect(call(badClient, 'group.list', {})).rejects.toThrow();
    await badClient.close();
  });

  it('工具业务错误以结构化结果标记失败', async () => {
    const err = await callExpectError(wsl, 'group.get', { group_id: 'grp_不存在' });
    expect(err.code).toBe('GROUP_NOT_FOUND');
    expect(err.message).toBeTruthy();
  });
});
