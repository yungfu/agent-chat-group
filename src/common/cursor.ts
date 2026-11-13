import { invalidArgument } from './errors';
import { utf8Bytes } from './validation';

/** 不透明游标：base64url 编码的字符串，往返校验保证可解码 */
export function encodeCursor(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string, maxBytes = 4096): string {
  if (utf8Bytes(cursor) > maxBytes) {
    throw invalidArgument('cursor 过长');
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (encodeCursor(decoded) !== cursor) {
    throw invalidArgument('cursor 无效');
  }
  return decoded;
}
