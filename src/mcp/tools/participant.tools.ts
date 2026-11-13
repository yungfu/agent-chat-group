import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ChatgroupConfig } from '../../common/config';
import { GroupsService } from '../../groups/groups.service';
import { handle } from '../tool-result';
import {
  declarationSchema,
  displayNameSchema,
  groupIdSchema,
  participantIdSchema,
  participantViewSchema,
} from '../schemas';

/** 参与者自我声明工具（成员操作，携带 group_id 与 participant_id） */
export function registerParticipantTools(
  server: McpServer,
  groups: GroupsService,
  _config: ChatgroupConfig,
): void {
  server.registerTool(
    'participant.update',
    {
      title: '更新自我声明',
      description:
        '更新自己的展示名称和/或声明，变更会以系统消息进入消息流。至少提供一个字段。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
        display_name: displayNameSchema.optional(),
        declaration: declarationSchema.optional(),
      },
      outputSchema: { participant: participantViewSchema },
    },
    async (args) =>
      handle(() => ({
        participant: groups.updateParticipant({
          groupId: args.group_id,
          participantId: args.participant_id,
          displayName: args.display_name,
          declaration: args.declaration,
        }),
      })),
  );

  server.registerTool(
    'participant.leave',
    {
      title: '退出聊天组',
      description:
        '退出后身份保留用于历史引用，但不能继续操作（包括读取）；重新参与需再次加入获得新 ID。',
      inputSchema: {
        group_id: groupIdSchema,
        participant_id: participantIdSchema,
      },
      outputSchema: { participant: participantViewSchema },
    },
    async (args) =>
      handle(() => ({
        participant: groups.leave({ groupId: args.group_id, participantId: args.participant_id }),
      })),
  );
}
