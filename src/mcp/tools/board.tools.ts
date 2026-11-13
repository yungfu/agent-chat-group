import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { ChatgroupConfig } from '../../common/config';
import { BoardService } from '../../board/board.service';
import { handle } from '../tool-result';
import {
  boardEntryViewSchema,
  boardKeySchema,
  boardValueSchema,
  cursorSchema,
  expectedVersionSchema,
  groupIdSchema,
  limitSchema,
  participantIdSchema,
} from '../schemas';

/** Board 共享协作状态工具 */
export function registerBoardTools(
  server: McpServer,
  board: BoardService,
  config: ChatgroupConfig,
): void {
  const { boardValueMaxBytes, boardKeyMaxChars, pageDefault, pageMax } = config.limits;

  server.registerTool(
    'board.list',
    {
      title: '列出 Board 条目',
      description: `按键名升序列出 board 条目（隐藏已删除条目）。默认每页 ${pageDefault} 条，最多 ${pageMax} 条。`,
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        cursor: cursorSchema.optional().describe('分页游标，首页不传'),
        limit: limitSchema.optional(),
      },
      outputSchema: {
        entries: z.array(boardEntryViewSchema),
        next_cursor: z.string().nullable(),
      },
    },
    async (args) =>
      handle(() =>
        board.list({
          groupId: args.group_id,
          participantId: args.participant_id,
          cursor: args.cursor,
          limit: args.limit,
        }),
      ),
  );

  server.registerTool(
    'board.get',
    {
      title: '读取 Board 条目',
      description: '读取一个条目的最新状态。已删除的条目返回 BOARD_ENTRY_DELETED 及墓碑版本。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        key: boardKeySchema,
      },
      outputSchema: { entry: boardEntryViewSchema },
    },
    async (args) =>
      handle(() => ({
        entry: board.get({
          groupId: args.group_id,
          participantId: args.participant_id,
          key: args.key,
        }),
      })),
  );

  server.registerTool(
    'board.put',
    {
      title: '写入 Board 条目',
      description: `创建或修改条目：expected_version=0 表示创建（要求键从未存在）；修改必须提供当前版本，不匹配返回 VERSION_CONFLICT；携带墓碑版本可重建已删除的键。value 为任意 JSON（最多 ${boardValueMaxBytes} 字节），key 最多 ${boardKeyMaxChars} 字符。写入不会自动生成消息，需要他人关注时请另行 message.send 通知。`,
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        key: boardKeySchema,
        value: boardValueSchema,
        expected_version: expectedVersionSchema,
      },
      outputSchema: { entry: boardEntryViewSchema },
    },
    async (args) =>
      handle(() => ({
        entry: board.put({
          groupId: args.group_id,
          participantId: args.participant_id,
          key: args.key,
          value: args.value,
          expectedVersion: args.expected_version,
        }),
      })),
  );

  server.registerTool(
    'board.delete',
    {
      title: '删除 Board 条目',
      description:
        '删除条目（保留内部墓碑并递增版本）。必须提供当前版本；重建该键需携带墓碑版本，重建后版本继续递增。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        key: boardKeySchema,
        expected_version: expectedVersionSchema,
      },
      outputSchema: {
        key: z.string(),
        version: z.number().int(),
        deleted: z.literal(true),
      },
    },
    async (args) =>
      handle(() =>
        board.delete({
          groupId: args.group_id,
          participantId: args.participant_id,
          key: args.key,
          expectedVersion: args.expected_version,
        }),
      ),
  );
}
