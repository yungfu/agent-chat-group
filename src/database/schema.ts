/** 显式迁移列表：每个版本一段幂等性由版本号保证的 DDL */

export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'init-schema',
    sql: `
      CREATE TABLE groups (
        id          TEXT PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status      TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
        last_seq    INTEGER NOT NULL DEFAULT 0,
        created_at  TEXT NOT NULL,
        closed_at   TEXT
      );

      CREATE TABLE participants (
        id            TEXT PRIMARY KEY,
        group_id      TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        display_name  TEXT NOT NULL,
        declaration   TEXT NOT NULL DEFAULT '',
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        joined_at     TEXT NOT NULL,
        left_at       TEXT
      );
      CREATE INDEX idx_participants_group ON participants(group_id);

      CREATE TABLE messages (
        id                     TEXT PRIMARY KEY,
        group_id               TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        seq                    INTEGER NOT NULL,
        type                   TEXT NOT NULL CHECK (type IN ('message', 'participant.joined', 'participant.updated', 'participant.left', 'group.closed')),
        sender_id              TEXT REFERENCES participants(id),
        actor_participant_id   TEXT REFERENCES participants(id),
        text                   TEXT NOT NULL,
        payload_json           TEXT,
        reply_to_message_id    TEXT REFERENCES messages(id),
        thread_root_message_id TEXT,
        created_at             TEXT NOT NULL,
        UNIQUE (group_id, seq)
      );
      CREATE INDEX idx_messages_group_seq ON messages(group_id, seq);
      CREATE INDEX idx_messages_reply ON messages(group_id, reply_to_message_id, seq);
      CREATE INDEX idx_messages_thread ON messages(group_id, thread_root_message_id, seq);

      CREATE TABLE message_mentions (
        message_id     TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        PRIMARY KEY (message_id, participant_id)
      );

      CREATE TABLE read_receipts (
        id             TEXT PRIMARY KEY,
        group_id       TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
        from_seq      INTEGER NOT NULL,
        through_seq   INTEGER NOT NULL,
        created_at     TEXT NOT NULL
      );
      CREATE INDEX idx_receipts_participant ON read_receipts(group_id, participant_id);

      CREATE TABLE board_entries (
        group_id    TEXT NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
        key         TEXT NOT NULL,
        value_json  TEXT,
        version     INTEGER NOT NULL,
        updated_by  TEXT NOT NULL REFERENCES participants(id),
        updated_at  TEXT NOT NULL,
        deleted_at  TEXT,
        PRIMARY KEY (group_id, key)
      );
    `,
  },
];
