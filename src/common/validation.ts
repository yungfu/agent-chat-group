/** 常用长度校验助手：字节数按 UTF-8 计算 */
import { BusinessError } from './errors';


export function utf8Bytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

export function assertTextBytes(
  text: string,
  maxBytes: number,
  label: string,
): void {
  const size = utf8Bytes(text);
  if (size > maxBytes) {
    throw new BusinessError(
      'PAYLOAD_TOO_LARGE',
      `${label}超出大小限制：${size} 字节 > ${maxBytes} 字节`,
      { field: label, actual_bytes: size, max_bytes: maxBytes },
    );
  }
}
