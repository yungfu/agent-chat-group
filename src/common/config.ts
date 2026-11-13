import { Inject } from '@nestjs/common';

/** 配置对象的注入 Token */
export const CONFIG = Symbol('CHATGROUP_CONFIG');

export interface LimitConfig {
  /** 列表默认分页大小 */
  pageDefault: number;
  /** 列表分页上限 */
  pageMax: number;
  /** 消息正文最大字节数（UTF-8） */
  textMaxBytes: number;
  /** board value JSON 最大字节数（UTF-8） */
  boardValueMaxBytes: number;
  /** 展示名称最大字符数 */
  nameMaxChars: number;
  /** 参与者声明最大字节数 */
  declarationMaxBytes: number;
  /** 组说明最大字节数 */
  descriptionMaxBytes: number;
  /** board key 最大字符数 */
  boardKeyMaxChars: number;
  /** 单条消息 mentions 数量上限 */
  mentionMaxCount: number;
}

export interface ChatgroupConfig {
  /** 固定访问令牌 */
  token: string;
  /** 监听端口 */
  port: number;
  /** 监听地址 */
  host: string;
  /** SQLite 数据文件路径 */
  dbPath: string;
  limits: LimitConfig;
}

function readInt(env: NodeJS.ProcessEnv, key: string, fallback: number, min = 1): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value) || value < min) {
    throw new Error(`环境变量 ${key} 必须是 >= ${min} 的整数，当前值：${raw}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ChatgroupConfig {
  const token = (env.CHATGROUP_TOKEN ?? '').trim();
  if (!token) {
    throw new Error('必须通过环境变量 CHATGROUP_TOKEN 配置固定访问令牌');
  }

  const limits: LimitConfig = {
    pageDefault: readInt(env, 'CHATGROUP_PAGE_DEFAULT', 50),
    pageMax: readInt(env, 'CHATGROUP_PAGE_MAX', 100),
    textMaxBytes: readInt(env, 'CHATGROUP_TEXT_MAX_BYTES', 32 * 1024),
    boardValueMaxBytes: readInt(env, 'CHATGROUP_BOARD_VALUE_MAX_BYTES', 64 * 1024),
    nameMaxChars: readInt(env, 'CHATGROUP_NAME_MAX_CHARS', 128),
    declarationMaxBytes: readInt(env, 'CHATGROUP_DECLARATION_MAX_BYTES', 8 * 1024),
    descriptionMaxBytes: readInt(env, 'CHATGROUP_DESCRIPTION_MAX_BYTES', 8 * 1024),
    boardKeyMaxChars: readInt(env, 'CHATGROUP_BOARD_KEY_MAX_CHARS', 256),
    mentionMaxCount: readInt(env, 'CHATGROUP_MENTION_MAX_COUNT', 100),
  };
  if (limits.pageDefault > limits.pageMax) {
    throw new Error('CHATGROUP_PAGE_DEFAULT 不能大于 CHATGROUP_PAGE_MAX');
  }

  return {
    token,
    port: readInt(env, 'CHATGROUP_PORT', 3000),
    host: (env.CHATGROUP_HOST ?? '0.0.0.0').trim(),
    dbPath: (env.CHATGROUP_DB_PATH ?? 'data/chatgroup.db').trim(),
    limits,
  };
}

/** 便捷装饰器：注入配置对象 */
export const InjectConfig = () => Inject(CONFIG);
