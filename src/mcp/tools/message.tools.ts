import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ChatgroupConfig } from '../../common/config';
import { MessagesService } from '../../messages/messages.service';
import { handle } from '../tool-result';
import {
  afterSeqSchema,
  groupIdSchema,
  limitSchema,
  messageIdSchema,
  messageViewSchema,
  mentionsSchema,
  messagesPageSchema,
  participantIdSchema,
  readReceiptSchema,
  textSchema,
} from '../schemas';

/** 消息流工具：统一发送、主动读取与确认、历史与回复查询 */
export function registerMessageTools(
  server: McpServer,
  messages: MessagesService,
  config: ChatgroupConfig,
): void {
  const { textMaxBytes, mentionMaxCount, pageDefault, pageMax } = config.limits;

  server.registerTool(
    'message.send',
    {
      title: '发送消息',
      description: `向组消息流发送一条普通消息（提问、结果、通知均使用本工具）。正文最多 ${textMaxBytes} 字节 UTF-8；mentions 必须是本组当前活跃成员的 participant_id（最多 ${mentionMaxCount} 个）；回复他人时填写 reply_to_message_id（必须是本组普通消息）。`,
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        text: textSchema,
        mentions: mentionsSchema.optional(),
        reply_to_message_id: messageIdSchema.optional().describe('回复的目标消息 ID'),
      },
      outputSchema: { message: messageViewSchema },
    },
    async (args) =>
      handle(() => ({
        message: messages.send({
          groupId: args.group_id,
          participantId: args.participant_id,
          text: args.text,
          mentions: args.mentions,
          replyToMessageId: args.reply_to_message_id,
        }),
      })),
  );

  server.registerTool(
    'message.read',
    {
      title: '读取未读消息',
      description: `从上次确认的位置之后主动拉取：返回其他参与者的普通消息和全部系统消息，跳过自己的普通消息。本工具不推进读取位置，成功接收后用 message.ack 确认。一次最多扫描 ${pageDefault} 条（上限 ${pageMax}）流记录，返回条数可能少于 limit（自身消息被跳过）；只要扫描位置前进就会返回可确认的回执。建议在开始工作、阶段结束和等待协作时主动读取。`,
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        limit: limitSchema.optional().describe('本次最多扫描的流记录数'),
      },
      outputSchema: {
        messages: z.array(messageViewSchema),
        read_receipt: z.string().nullable(),
        has_more: z.boolean(),
      },
    },
    async (args) =>
      handle(() =>
        messages.read({
          groupId: args.group_id,
          participantId: args.participant_id,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    'message.ack',
    {
      title: '确认接收消息',
      description:
        '用 message.read 返回的回执确认接收，读取位置更新为当前值与回执结束位置中的较大值。重复 ack 安全，旧回执不会让进度倒退。未确认的消息可能重复返回，按 message_id 识别。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        read_receipt: readReceiptSchema,
      },
      outputSchema: { last_read_seq: z.number().int() },
    },
    async (args) =>
      handle(() =>
        messages.ack({
          groupId: args.group_id,
          participantId: args.participant_id,
          readReceipt: args.read_receipt,
        }),
      ),
  );

  server.registerTool(
    'message.get',
    {
      title: '读取单条消息',
      description: '完整读取一条消息，不改变读取进度。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        message_id: messageIdSchema,
      },
      outputSchema: { message: messageViewSchema },
    },
    async (args) =>
      handle(() => ({
        message: messages.get({
          groupId: args.group_id,
          participantId: args.participant_id,
          messageId: args.message_id,
        }),
      })),
  );

  server.registerTool(
    'message.list',
    {
      title: '查询组历史消息',
      description: `按 seq 升序分页读取组历史（包含自身消息与系统消息），不改变读取进度。after_seq 传上次响应的 next_seq。`,
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        after_seq: afterSeqSchema.optional(),
        limit: limitSchema.optional(),
      },
      outputSchema: messagesPageSchema,
    },
    async (args) =>
      handle(() =>
        messages.list({
          groupId: args.group_id,
          participantId: args.participant_id,
          afterSeq: args.after_seq,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    'message.replies',
    {
      title: '查询直接回复',
      description: '查询某条普通消息的直接回复（只匹配 reply_to_message_id），按 seq 升序分页。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        message_id: messageIdSchema,
        after_seq: afterSeqSchema.optional(),
        limit: limitSchema.optional(),
      },
      outputSchema: messagesPageSchema,
    },
    async (args) =>
      handle(() =>
        messages.replies({
          groupId: args.group_id,
          participantId: args.participant_id,
          messageId: args.message_id,
          afterSeq: args.after_seq,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    'message.thread',
    {
      title: '查询整个讨论',
      description:
        '按 thread_root_message_id 返回一条普通消息所在的整个讨论（含根消息及其全部层级回复），按 seq 升序分页。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        message_id: messageIdSchema.describe('讨论内任意一条普通消息'),
        after_seq: afterSeqSchema.optional(),
        limit: limitSchema.optional(),
      },
      outputSchema: messagesPageSchema,
    },
    async (args) =>
      handle(() =>
        messages.thread({
          groupId: args.group_id,
          participantId: args.participant_id,
          messageId: args.message_id,
          afterSeq: args.after_seq,
          limit: args.limit,
        }),
      ),
  );
}
