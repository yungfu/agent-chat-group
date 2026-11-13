import { Inject, Injectable } from '@nestjs/common';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CONFIG, ChatgroupConfig } from '../common/config';
import { BoardService } from '../board/board.service';
import { GroupsService } from '../groups/groups.service';
import { MessagesService } from '../messages/messages.service';
import { registerBoardTools } from './tools/board.tools';
import { registerGroupTools } from './tools/group.tools';
import { registerMessageTools } from './tools/message.tools';
import { registerParticipantTools } from './tools/participant.tools';

export const SERVER_NAME = 'chatgroup';
export const SERVER_VERSION = '1.0.0';

/**
 * 按请求创建 McpServer 实例（无状态模式）。
 * MCP 层只做协议适配与结构校验，业务规则全部在 service。
 */
@Injectable()
export class McpServerFactory {
  constructor(
    private readonly groups: GroupsService,
    private readonly messages: MessagesService,
    private readonly board: BoardService,
    @Inject(CONFIG) private readonly config: ChatgroupConfig,
  ) {}

  create(): McpServer {
    const server = new McpServer(
      { name: SERVER_NAME, version: SERVER_VERSION },
      { capabilities: { tools: {} } },
    );
    registerGroupTools(server, this.groups, this.config);
    registerParticipantTools(server, this.groups, this.config);
    registerMessageTools(server, this.messages, this.config);
    registerBoardTools(server, this.board, this.config);
    return server;
  }
}
