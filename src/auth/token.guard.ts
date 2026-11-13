import { createHash, timingSafeEqual } from 'node:crypto';
import { CanActivate, ExecutionContext, HttpException, Inject, Injectable } from '@nestjs/common';
import { Request } from 'express';
import { CONFIG, ChatgroupConfig } from '../common/config';

/** 固定 Token 认证：Authorization: Bearer <token>，认证失败在 HTTP 层返回 401 */
@Injectable()
export class TokenGuard implements CanActivate {
  constructor(@Inject(CONFIG) private readonly config: ChatgroupConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    const header = String(request.headers['authorization'] ?? '');
    const match = /^Bearer\s+(.+)$/.exec(header);
    if (!match || !this.tokenEquals(match[1].trim())) {
      throw new HttpException(
        { code: 'UNAUTHORIZED', message: '认证失败：需要 Authorization: Bearer <token>' },
        401,
      );
    }
    return true;
  }

  /** 常数时间比较（先哈希对齐长度） */
  private tokenEquals(provided: string): boolean {
    const providedHash = createHash('sha256').update(provided).digest();
    const expectedHash = createHash('sha256').update(this.config.token).digest();
    return timingSafeEqual(providedHash, expectedHash);
  }
}
