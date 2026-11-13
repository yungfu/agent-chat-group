import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { CONFIG, ChatgroupConfig } from '../common/config';
import { BusinessError } from '../common/errors';
import { MIGRATIONS } from './schema';

type Row = Record<string, unknown>;

export type SqlParam = string | number | null;

/** SQLite busy / locked 时抛出的业务错误 */
function mapSqliteError(error: unknown): unknown {
  if (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED/.test(error.message)) {
    return new BusinessError('STORAGE_BUSY', '存储繁忙，请稍后重试', {
      reason: error.message,
    });
  }
  return error;
}

/**
 * SQLite 访问入口：单连接、WAL、外键开启。
 * 事务助手 tx() 可重入：嵌套调用直接在当前事务内执行。
 * 所有写事务使用 BEGIN IMMEDIATE，写入时在事务内检查组状态，
 * 避免关闭与写入的竞态（设计 §9）。
 */
@Injectable()
export class DatabaseService implements OnModuleInit, OnModuleDestroy {
  private db!: DatabaseSync;
  private txDepth = 0;

  constructor(@Inject(CONFIG) private readonly config: ChatgroupConfig) {}

  onModuleInit(): void {
    if (this.config.dbPath !== ':memory:') {
      mkdirSync(dirname(this.config.dbPath), { recursive: true });
    }
    this.db = new DatabaseSync(this.config.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
    `);
    this.migrate();
  }

  onModuleDestroy(): void {
    this.db?.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        version    INTEGER PRIMARY KEY,
        name       TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )
    `);
    const applied = new Set(
      this.all('SELECT version FROM schema_migrations').map((row) => Number(row.version)),
    );
    for (const migration of MIGRATIONS) {
      if (applied.has(migration.version)) continue;
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.exec(migration.sql);
        this.db
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, new Date().toISOString());
        this.db.exec('COMMIT');
      } catch (error) {
        this.db.exec('ROLLBACK');
        throw error;
      }
    }
  }

  /**
   * 在事务中执行 fn。
   * - immediate：写事务，拿到保留锁后再做业务检查，保证「检查 + 写入」原子。
   * - deferred：只读快照，用于需要多次读取保持一致性的查询。
   */
  tx<T>(fn: () => T, mode: 'immediate' | 'deferred' = 'immediate'): T {
    if (this.txDepth > 0) return fn();
    try {
      this.db.exec(mode === 'immediate' ? 'BEGIN IMMEDIATE' : 'BEGIN DEFERRED');
      // 延迟外键检查到 COMMIT：组销毁等批量删除不依赖删除顺序
      this.db.exec('PRAGMA defer_foreign_keys = ON');
    } catch (error) {
      throw mapSqliteError(error);
    }
    this.txDepth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      try {
        this.db.exec('ROLLBACK');
      } catch {
        // 事务已失效时忽略
      }
      throw mapSqliteError(error);
    } finally {
      this.txDepth -= 1;
    }
  }

  run(sql: string, ...params: SqlParam[]): { changes: number } {
    try {
      const result = this.db.prepare(sql).run(...params);
      return { changes: Number(result.changes) };
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  get(sql: string, ...params: SqlParam[]): Row | undefined {
    try {
      return this.db.prepare(sql).get(...params) as Row | undefined;
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  all(sql: string, ...params: SqlParam[]): Row[] {
    try {
      return this.db.prepare(sql).all(...params) as Row[];
    } catch (error) {
      throw mapSqliteError(error);
    }
  }

  /** 判断某个 UNIQUE 冲突（消息/参与者 ID 撞随机串） */
  isUniqueViolation(error: unknown): boolean {
    if (error instanceof Error) {
      return /UNIQUE constraint failed/.test(error.message);
    }
    return false;
  }
}
