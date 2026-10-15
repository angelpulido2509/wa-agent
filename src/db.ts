import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

export type Role = 'user' | 'bot' | 'owner';

export interface StoredMessage {
  id: number;
  jid: string;
  waId: string;
  role: Role;
  text: string;
  ts: number;
}

export interface ChatRow {
  jid: string;
  name: string | null;
  phone: string | null;
  pausedUntil: number | null;
  pauseReason: string | null;
  lastTs: number;
  lastText: string | null;
}

export interface NewMessage {
  jid: string;
  waId: string;
  role: Role;
  text: string;
  /** epoch ms */
  ts: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  jid   TEXT    NOT NULL,
  wa_id TEXT    NOT NULL,
  role  TEXT    NOT NULL CHECK (role IN ('user', 'bot', 'owner')),
  text  TEXT    NOT NULL,
  ts    INTEGER NOT NULL,
  UNIQUE (jid, wa_id)
);
CREATE INDEX IF NOT EXISTS idx_messages_jid_ts ON messages (jid, ts);

CREATE TABLE IF NOT EXISTS chats (
  jid          TEXT PRIMARY KEY,
  name         TEXT,
  phone        TEXT,
  paused_until INTEGER,
  pause_reason TEXT,
  last_ts      INTEGER NOT NULL DEFAULT 0
);
`;

interface MessageRecord {
  id: number;
  jid: string;
  wa_id: string;
  role: Role;
  text: string;
  ts: number;
}

interface ChatRecord {
  jid: string;
  name: string | null;
  phone: string | null;
  paused_until: number | null;
  pause_reason: string | null;
  last_ts: number;
  last_text: string | null;
}

export type Db = ReturnType<typeof createDb>;

/** Abre (o crea) la base SQLite en modo WAL. Usa ':memory:' en tests. */
export function createDb(file: string) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const sqlite = new Database(file);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.exec(SCHEMA);

  const stmt = {
    insertMessage: sqlite.prepare(
      `INSERT OR IGNORE INTO messages (jid, wa_id, role, text, ts) VALUES (@jid, @waId, @role, @text, @ts)`,
    ),
    touchChat: sqlite.prepare(
      `INSERT INTO chats (jid, last_ts) VALUES (@jid, @ts)
       ON CONFLICT (jid) DO UPDATE SET last_ts = MAX(chats.last_ts, excluded.last_ts)`,
    ),
    recent: sqlite.prepare(
      `SELECT * FROM (SELECT * FROM messages WHERE jid = ? ORDER BY ts DESC, id DESC LIMIT ?) ORDER BY ts ASC, id ASC`,
    ),
    pause: sqlite.prepare(
      `INSERT INTO chats (jid, paused_until, pause_reason) VALUES (@jid, @until, @reason)
       ON CONFLICT (jid) DO UPDATE SET paused_until = excluded.paused_until, pause_reason = excluded.pause_reason`,
    ),
    resume: sqlite.prepare(`UPDATE chats SET paused_until = NULL, pause_reason = NULL WHERE jid = ?`),
    pausedUntil: sqlite.prepare(`SELECT paused_until FROM chats WHERE jid = ?`),
    repliesSince: sqlite.prepare(`SELECT COUNT(*) AS n FROM messages WHERE jid = ? AND role = 'bot' AND ts >= ?`),
    listChats: sqlite.prepare(
      `SELECT c.*, (SELECT text FROM messages m WHERE m.jid = c.jid ORDER BY ts DESC, id DESC LIMIT 1) AS last_text
       FROM chats c ORDER BY c.last_ts DESC LIMIT ?`,
    ),
    getChat: sqlite.prepare(
      `SELECT c.*, (SELECT text FROM messages m WHERE m.jid = c.jid ORDER BY ts DESC, id DESC LIMIT 1) AS last_text
       FROM chats c WHERE c.jid = ?`,
    ),
    setName: sqlite.prepare(
      `INSERT INTO chats (jid, name) VALUES (?, ?) ON CONFLICT (jid) DO UPDATE SET name = excluded.name`,
    ),
    setPhone: sqlite.prepare(
      `INSERT INTO chats (jid, phone) VALUES (?, ?) ON CONFLICT (jid) DO UPDATE SET phone = excluded.phone`,
    ),
  };

  const toMessage = (r: MessageRecord): StoredMessage => ({
    id: r.id,
    jid: r.jid,
    waId: r.wa_id,
    role: r.role,
    text: r.text,
    ts: r.ts,
  });

  const toChat = (r: ChatRecord): ChatRow => ({
    jid: r.jid,
    name: r.name,
    phone: r.phone,
    pausedUntil: r.paused_until,
    pauseReason: r.pause_reason,
    lastTs: r.last_ts,
    lastText: r.last_text,
  });

  const saveTx = sqlite.transaction((msg: NewMessage): boolean => {
    const { changes } = stmt.insertMessage.run(msg);
    if (changes === 0) return false;
    stmt.touchChat.run({ jid: msg.jid, ts: msg.ts });
    return true;
  });

  return {
    /** Guarda un mensaje. Devuelve false si (jid, waId) ya existía. */
    saveMessage(msg: NewMessage): boolean {
      return saveTx(msg);
    },

    recentMessages(jid: string, limit = 30): StoredMessage[] {
      return (stmt.recent.all(jid, limit) as MessageRecord[]).map(toMessage);
    },

    pauseChat(jid: string, untilMs: number, reason: string): void {
      stmt.pause.run({ jid, until: untilMs, reason });
    },

    resumeChat(jid: string): void {
      stmt.resume.run(jid);
    },

    isPaused(jid: string, now = Date.now()): boolean {
      const row = stmt.pausedUntil.get(jid) as { paused_until: number | null } | undefined;
      return row?.paused_until != null && row.paused_until > now;
    },

    repliesLastHour(jid: string, now = Date.now()): number {
      const row = stmt.repliesSince.get(jid, now - 3_600_000) as { n: number };
      return row.n;
    },

    listChats(limit = 200): ChatRow[] {
      return (stmt.listChats.all(limit) as ChatRecord[]).map(toChat);
    },

    getChat(jid: string): ChatRow | undefined {
      const row = stmt.getChat.get(jid) as ChatRecord | undefined;
      return row ? toChat(row) : undefined;
    },

    setChatName(jid: string, name: string): void {
      stmt.setName.run(jid, name);
    },

    setChatPhone(jid: string, phone: string): void {
      stmt.setPhone.run(jid, phone);
    },

    close(): void {
      sqlite.close();
    },
  };
}
