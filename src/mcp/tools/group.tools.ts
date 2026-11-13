import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ChatgroupConfig } from '../../common/config';
import { GroupsService } from '../../groups/groups.service';
import { handle } from '../tool-result';
import {
  cursorSchema,
  displayNameSchema,
  declarationSchema,
  groupViewSchema,
  groupIdSchema,
  limitSchema,
  participantViewSchema,
} from '../schemas';

/** 聊天组生命周期工具（固定 Token 即可调用） */
export function registerGroupTools(
  server: McpServer,
  groups: GroupsService,
  config: ChatgroupConfig,
): void {
  const { nameMaxChars, descriptionMaxBytes, pageDefault, pageMax } = config.limits;

  server.registerTool(
    'group.create',
    {
      title: '创建聊天组',
      description: `创建一个新的聊天组。注意：仅创建，不会自动加入——当前会话此时还不是成员，不能收发消息；创建成功后请另行调用 group.join 加入（意图建立协作时应在同一工作流中连续调用 create + join）。名称最多 ${nameMaxChars} 字符，说明最多 ${descriptionMaxBytes} 字节。`,
      inputSchema: {
        name: displayNameSchema.describe('组名称'),
        description: declarationSchema.optional().describe('组说明'),
      },
      outputSchema: { group: groupViewSchema, hint: z.string() },
    },
    async (args) =>
      handle(() => {
        const group = groups.create({ name: args.name, description: args.description });
        return {
          group,
          hint: `组已创建（${group.group_id}），但仅完成创建：当前会话尚未加入，还不能收发消息。下一步请调用 group.join（group_id=${group.group_id}，display_name=你的展示名称）加入；加入后请保存返回的 participant_id，重连时继续使用原 ID，不要重复加入。`,
        };
      }),
  );

  server.registerTool(
    'group.list',
    {
      title: '查询聊天组列表',
      description: `按创建顺序分页列出全部聊天组（含已关闭）。默认每页 ${pageDefault} 条，最多 ${pageMax} 条。`,
      inputSchema: {
        cursor: cursorSchema.optional().describe('分页游标，首页不传'),
        limit: limitSchema.optional(),
      },
      outputSchema: {
        groups: z.array(groupViewSchema),
        next_cursor: z.string().nullable(),
      },
    },
    async (args) => handle(() => groups.list({ cursor: args.cursor, limit: args.limit })),
  );

  server.registerTool(
    'group.get',
    {
      title: '查询聊天组详情',
      description: '查询组信息与全部成员（含已退出成员及其状态），用于身份恢复或了解协作方。',
      inputSchema: { group_id: groupIdSchema },
      outputSchema: {
        group: groupViewSchema,
        participants: z.array(participantViewSchema),
      },
    },
    async (args) => handle(() => groups.get(args.group_id)),
  );

  server.registerTool(
    'group.join',
    {
      title: '加入聊天组',
      description: `以新身份加入组，服务端分配 participant_id（p_ 前缀）。加入成功后请立即保存并向用户完整展示 participant_id、展示名与声明（结果 summary 已汇总）：participant_id 是本组内的通信标识，重连或服务重启后继续使用原 ID，不要重复加入（每次加入都会创建新身份）。加入时的读取位置为当前组序号，加入前的历史不算未读（可通过 message.list 查询）。展示名称最多 ${nameMaxChars} 字符，声明最多 ${descriptionMaxBytes} 字节。`,
      inputSchema: {
        group_id: groupIdSchema,
        display_name: displayNameSchema,
        declaration: declarationSchema.optional().describe('自我声明'),
      },
      outputSchema: {
        self: participantViewSchema,
        group: groupViewSchema,
        participants: z.array(participantViewSchema),
        summary: z.string(),
      },
    },
    async (args) =>
      handle(() => {
        const result = groups.join({
          groupId: args.group_id,
          displayName: args.display_name,
          declaration: args.declaration,
        });
        const members = result.participants
          .map(
            (p) =>
              `${p.participant_id}（${p.display_name}${p.declaration ? `：${p.declaration}` : ''}）`,
          )
          .join('、');
        const summary = [
          `已加入组「${result.group.name}」（group_id=${result.group.group_id}）。`,
          `自身身份：participant_id=${result.self.participant_id}，display_name=「${result.self.display_name}」，declaration=「${result.self.declaration}」。请立即妥善保存 participant_id 并告知用户：重连或服务重启后继续使用该 ID，不要重复加入（每次加入都会创建新身份）。`,
          `当前成员（${result.participants.length} 名，含自身）：${members}`,
        ].join('\n');
        return { ...result, summary };
      }),
  );

  server.registerTool(
    'group.close',
    {
      title: '关闭聊天组',
      description: '关闭后禁止加入与写入，仍可读取、查询与确认接收；不支持重新打开。重复关闭是幂等的，不会重复追加系统消息。',
      inputSchema: { group_id: groupIdSchema },
      outputSchema: { group: groupViewSchema },
    },
    async (args) => handle(() => ({ group: groups.close(args.group_id) })),
  );

  server.registerTool(
    'group.delete',
    {
      title: '销毁聊天组',
      description: '删除组及其全部消息、成员、board 与回执数据，不可恢复。active 或 closed 状态均可销毁。',
      inputSchema: { group_id: groupIdSchema },
      outputSchema: { group_id: z.string(), deleted: z.literal(true) },
    },
    async (args) => handle(() => groups.delete(args.group_id)),
  );
}
