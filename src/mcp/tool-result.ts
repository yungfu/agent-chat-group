import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { BusinessError, invalidArgument } from '../common/errors';

/** 成功结果：同时输出文本 JSON 与结构化内容，兼容各类客户端 */
export function ok(result: object): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result as Record<string, unknown>,
  };
}

/** 业务失败：稳定 code + 可读 message + details，明确标记调用失败 */
export function fail(error: BusinessError): CallToolResult {
  const body: Record<string, unknown> = { code: error.code, message: error.message };
  if (error.details !== undefined) {
    body.details = error.details;
  }
  return {
    content: [{ type: 'text', text: JSON.stringify(body) }],
    isError: true,
  };
}

/** 工具处理器统一包装：业务错误转结构化错误结果，未知错误原样抛给 SDK */
export async function handle(fn: () => object | Promise<object>): Promise<CallToolResult> {
  try {
    return ok(await fn());
  } catch (error) {
    if (error instanceof BusinessError) return fail(error);
    if (error instanceof z.ZodError) {
      return fail(invalidArgument('参数校验失败', { issues: error.issues }));
    }
    throw error;
  }
}
