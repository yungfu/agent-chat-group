import { Controller, Get, Post, Delete, Req, Res, UseGuards } from '@nestjs/common';
import { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { TokenGuard } from '../auth/token.guard';
import { McpServerFactory } from './mcp.factory';

/**
 * MCP Streamable HTTP 端点（无状态 JSON 模式）：
 * 每个请求独立创建 server + transport，会话状态全部落在 SQLite，
 * 参与者身份由工具参数显式携带，不绑定 HTTP 连接。
 */
@Controller()
export class McpController {
  constructor(private readonly factory: McpServerFactory) {}

  @Post('mcp')
  @UseGuards(TokenGuard)
  async handleMcp(@Req() req: Request, @Res() res: Response): Promise<void> {
    const server = this.factory.create();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      try {
        await server.close();
      } catch {
        // 响应已发出，关闭失败不影响结果
      }
    }
  }

  /** 无状态 + JSON 模式不提供 SSE 通道 */
  @Get('mcp')
  mcpGet(@Res() res: Response): void {
    res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: '本服务不提供 SSE 通道，请使用 POST' });
  }

  @Delete('mcp')
  mcpDelete(@Res() res: Response): void {
    res.status(405).json({ code: 'METHOD_NOT_ALLOWED', message: '无状态服务无需删除会话' });
  }

  @Get('healthz')
  health(): { status: string } {
    return { status: 'ok' };
  }
}
