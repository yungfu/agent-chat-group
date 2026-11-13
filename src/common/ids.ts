import { randomBytes } from 'node:crypto';

/**
 * 生成带前缀的服务端 ID，例如 grp_x7Kp…、p_Ab3d…、msg_Q9…、rr_…
 * 随机 base64url，无顺序语义；唯一性由数据库主键兜底。
 */
export function newId(prefix: string, randomBytesLength = 16): string {
  return `${prefix}_${randomBytes(randomBytesLength).toString('base64url')}`;
}
