/** 业务错误码，与设计文档 §11 保持一致 */
export type ErrorCode =
  | 'GROUP_NOT_FOUND'
  | 'GROUP_CLOSED'
  | 'PARTICIPANT_NOT_FOUND'
  | 'PARTICIPANT_LEFT'
  | 'MESSAGE_NOT_FOUND'
  | 'INVALID_REPLY_TARGET'
  | 'INVALID_MENTION'
  | 'INVALID_READ_RECEIPT'
  | 'BOARD_ENTRY_NOT_FOUND'
  | 'BOARD_ENTRY_DELETED'
  | 'VERSION_CONFLICT'
  | 'INVALID_ARGUMENT'
  | 'PAYLOAD_TOO_LARGE'
  | 'STORAGE_BUSY';

/** 业务错误：携带稳定 code，最终映射为 MCP 结构化错误结果 */
export class BusinessError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'BusinessError';
  }
}

export function invalidArgument(message: string, details?: Record<string, unknown>): BusinessError {
  return new BusinessError('INVALID_ARGUMENT', message, details);
}

export function payloadTooLarge(message: string, details?: Record<string, unknown>): BusinessError {
  return new BusinessError('PAYLOAD_TOO_LARGE', message, details);
}
