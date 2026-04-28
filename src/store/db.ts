import Database from "better-sqlite3";
import { DB_PATH, ensureMaxHome } from "../paths.js";

let db: Database.Database | undefined;
let logInsertCount = 0;
let fts5Available = false;

export function getDb(): Database.Database {
  if (!db) {
    ensureMaxHome();
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.exec(`
      CREATE TABLE IF NOT EXISTS worker_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE NOT NULL,
        copilot_session_id TEXT,
        working_dir TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        last_output TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_sessions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT UNIQUE NOT NULL,
        name TEXT NOT NULL,
        model TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'idle',
        current_task TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_tasks (
        task_id TEXT PRIMARY KEY,
        agent_slug TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running',
        result TEXT,
        origin_channel TEXT,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        completed_at DATETIME
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS max_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ado_reviewed_prs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_url TEXT NOT NULL,
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_id INTEGER NOT NULL,
        reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_url, project, repo, pr_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS ado_fix_comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        org_url TEXT NOT NULL,
        project TEXT NOT NULL,
        repo TEXT NOT NULL,
        pr_id INTEGER NOT NULL,
        thread_id INTEGER NOT NULL,
        comment_id INTEGER NOT NULL,
        processed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(org_url, project, repo, pr_id, thread_id, comment_id)
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS conversation_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'unknown',
        ts DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL CHECK(category IN ('preference', 'fact', 'project', 'person', 'routine')),
        content TEXT NOT NULL,
        source TEXT NOT NULL DEFAULT 'user',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_accessed DATETIME DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Migrate: if the table already existed with a stricter CHECK, recreate it
    try {
      db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES ('system', '__migration_test__', 'test')`).run();
      db.prepare(`DELETE FROM conversation_log WHERE content = '__migration_test__'`).run();
    } catch {
      // CHECK constraint doesn't allow 'system' — recreate table preserving data
      db.exec(`ALTER TABLE conversation_log RENAME TO conversation_log_old`);
      db.exec(`
        CREATE TABLE conversation_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'unknown',
          ts DATETIME DEFAULT CURRENT_TIMESTAMP
        )
      `);
      db.exec(`INSERT INTO conversation_log (role, content, source, ts) SELECT role, content, source, ts FROM conversation_log_old`);
      db.exec(`DROP TABLE conversation_log_old`);
    }
    // Prune conversation log at startup — keep more history for better recovery
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();

    // Set up FTS5 for memory search (graceful fallback if not available)
    try {
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
          content,
          content_rowid='id'
        )
      `);
      // Sync triggers
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
        END
      `);
      db.exec(`
        CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.id, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.id, new.content);
        END
      `);
      // Backfill: check if FTS is in sync by comparing row counts
      const memCount = (db.prepare(`SELECT COUNT(*) as c FROM memories`).get() as { c: number }).c;
      const ftsCount = (db.prepare(`SELECT COUNT(*) as c FROM memories_fts`).get() as { c: number }).c;
      if (memCount > 0 && ftsCount < memCount) {
        db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild')`);
      }
      fts5Available = true;
    } catch {
      // FTS5 not available in this SQLite build — fall back to LIKE queries
      fts5Available = false;
    }
  }
  return db;
}

export function getState(key: string): string | undefined {
  const db = getDb();
  const row = db.prepare(`SELECT value FROM max_state WHERE key = ?`).get(key) as { value: string } | undefined;
  return row?.value;
}

export function setState(key: string, value: string): void {
  const db = getDb();
  db.prepare(`INSERT OR REPLACE INTO max_state (key, value) VALUES (?, ?)`).run(key, value);
}

/** Remove a key from persistent state. */
export function deleteState(key: string): void {
  const db = getDb();
  db.prepare(`DELETE FROM max_state WHERE key = ?`).run(key);
}

/** Log a conversation turn (user, assistant, or system). */
export function logConversation(role: "user" | "assistant" | "system", content: string, source: string): void {
  const db = getDb();
  db.prepare(`INSERT INTO conversation_log (role, content, source) VALUES (?, ?, ?)`).run(role, content, source);
  // Keep last 1000 entries to support context recovery after session loss
  logInsertCount++;
  if (logInsertCount % 50 === 0) {
    db.prepare(`DELETE FROM conversation_log WHERE id NOT IN (SELECT id FROM conversation_log ORDER BY id DESC LIMIT 1000)`).run();
  }
}

/** Get recent conversation history formatted for injection into system message. */
export function getRecentConversation(limit = 20): string {
  const db = getDb();
  const rows = db.prepare(
    `SELECT role, content, source, ts FROM conversation_log ORDER BY id DESC LIMIT ?`
  ).all(limit) as { role: string; content: string; source: string; ts: string }[];

  if (rows.length === 0) return "";

  // Reverse so oldest is first (chronological order)
  rows.reverse();

  return rows.map((r) => {
    const tag = r.role === "user" ? `[${r.source}] User`
      : r.role === "system" ? `[${r.source}] System`
      : "Max";
    // Truncate long messages to keep context manageable
    const content = r.content.length > 1500 ? r.content.slice(0, 1500) + "…" : r.content;
    return `${tag}: ${content}`;
  }).join("\n\n");
}

// ---------------------------------------------------------------------------
// SQLite memory functions removed — wiki is the single source of truth.
// The memories table and FTS5 index are preserved in the schema for safety
// (existing data is not deleted), but no code reads or writes to them.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// ADO PR review deduplication
// ---------------------------------------------------------------------------

/** Return true if this PR has already been reviewed (exists in ado_reviewed_prs). */
export function hasPrBeenReviewed(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM ado_reviewed_prs WHERE org_url = ? AND project = ? AND repo = ? AND pr_id = ?`
    )
    .get(orgUrl, project, repo, prId);
  return row !== undefined;
}

/** Mark a PR as reviewed so the poller won't trigger it again. */
export function markPrReviewed(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO ado_reviewed_prs (org_url, project, repo, pr_id) VALUES (?, ?, ?, ?)`
  ).run(orgUrl, project, repo, prId);
}

// ---------------------------------------------------------------------------
// ADO /max:fix comment deduplication
// ---------------------------------------------------------------------------

/** Return true if this PR comment has already been processed as a /max:fix trigger. */
export function hasFixCommentBeenProcessed(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  commentId: number
): boolean {
  const db = getDb();
  const row = db
    .prepare(
      `SELECT 1 FROM ado_fix_comments WHERE org_url = ? AND project = ? AND repo = ? AND pr_id = ? AND thread_id = ? AND comment_id = ?`
    )
    .get(orgUrl, project, repo, prId, threadId, commentId);
  return row !== undefined;
}

/** Mark a /max:fix comment as processed so it won't trigger the coder again. */
export function markFixCommentProcessed(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  threadId: number,
  commentId: number
): void {
  const db = getDb();
  db.prepare(
    `INSERT OR IGNORE INTO ado_fix_comments (org_url, project, repo, pr_id, thread_id, comment_id) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(orgUrl, project, repo, prId, threadId, commentId);
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = undefined;
  }
}
