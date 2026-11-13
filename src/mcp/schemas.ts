import { z } from 'zod';

/* --------------------------- 输入 schema（结构层） --------------------------- */
/* 语义与限额校验统一放在 service（返回稳定业务错误码），这里只约束结构。 */

export const groupIdSchema = z
  .string()
  .min(1)
  .describe('组 ID（grp_ 前缀，由 group.create 返回或 group.list 查询）');

export const participantIdSchema = z
  .string()
  .min(1)
  .describe('参与者 ID（p_ 前缀，group.join 返回；重连时继续使用原 ID）');

export const messageIdSchema = z.string().min(1).describe('消息 ID（msg_ 前缀）');

export const displayNameSchema = z.string().min(1).describe('展示名称（允许重复，不用于寻址）');

export const declarationSchema = z
  .string()
  .describe('自由文本自我声明：角色、能力、环境等（快照进入系统消息）');

export const textSchema = z.string().min(1).describe('消息正文（UTF-8，大小受服务端限制）');

export const mentionsSchema = z
  .array(z.string().min(1))
  .describe('@ 的参与者 ID 列表（必须是本组当前活跃成员，仅影响关联展示）');

export const readReceiptSchema = z
  .string()
  .min(1)
  .describe('message.read 返回的读取回执');

export const cursorSchema = z.string().min(1).describe('分页游标（上次响应的 next_cursor）');

export const limitSchema = z.number().int().describe('分页大小（服务端有默认值与上限）');

export const afterSeqSchema = z.number().int().min(0).describe('从该 seq 之后开始查询（不含）');

export const boardKeySchema = z.string().min(1).describe('board 键名（由参与方协商，如 progress/p_desktop）');

export const boardValueSchema = z.json().describe('任意 JSON 值（大小受服务端限制）');

export const expectedVersionSchema = z
  .number()
  .int()
  .min(0)
  .describe('期望的当前版本：0 表示创建（要求键从未存在）；N 表示修改/删除/重建须匹配当前版本');

/* --------------------------- 输出 schema（结构层） --------------------------- */

export const groupViewSchema = z.object({
  group_id: z.string(),
  name: z.string(),
  description: z.string(),
  status: z.enum(['active', 'closed']),
  created_at: z.string(),
  closed_at: z.string().nullable(),
});

export const participantViewSchema = z.object({
  participant_id: z.string(),
  display_name: z.string(),
  declaration: z.string(),
  last_read_seq: z.number().int(),
  joined_at: z.string(),
  left_at: z.string().nullable(),
});

export const replyPreviewSchema = z.object({
  message_id: z.string(),
  sender_id: z.string().nullable(),
  preview: z.string(),
});

export const messageViewSchema = z.object({
  message_id: z.string(),
  group_id: z.string(),
  seq: z.number().int(),
  type: z.enum(['message', 'participant.joined', 'participant.updated', 'participant.left', 'group.closed']),
  sender_id: z.string().nullable(),
  actor_participant_id: z.string().nullable(),
  text: z.string(),
  payload: z.unknown().nullable(),
  mentions: z.array(z.string()),
  reply_to_message_id: z.string().nullable(),
  reply_to_sender_id: z.string().nullable(),
  thread_root_message_id: z.string().nullable(),
  reply_preview: replyPreviewSchema.nullable(),
  created_at: z.string(),
  is_reply_to_me: z.boolean(),
  is_mentioned: z.boolean(),
});

export const boardEntryViewSchema = z.object({
  key: z.string(),
  value: z.unknown().nullable(),
  version: z.number().int(),
  updated_by: z.string(),
  updated_at: z.string(),
});

export const messagesPageSchema = {
  messages: z.array(messageViewSchema),
  next_seq: z.number().int(),
  has_more: z.boolean(),
};
