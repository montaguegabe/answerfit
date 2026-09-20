import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const DB_DIR = path.join(process.cwd(), "db");
const DB_PATH = process.env.ANSWERFIT_DB || path.join(DB_DIR, "answerfit.db");

let _db: Database.Database | null = null;

export function db(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DB_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  migrate(_db);
  return _db;
}

function migrate(d: Database.Database) {
  d.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'synthetic',  -- 'real' | 'synthetic'
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS concepts (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT,
      viz TEXT,                 -- preferred representation hint
      prereqs TEXT,             -- JSON array of concept ids
      contrasts TEXT,           -- JSON array of concept ids
      source TEXT DEFAULT 'seed' -- 'seed' | 'extracted'
    );

    -- Immutable evidence log. State is always derived from this, never stored as truth.
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      ts TEXT NOT NULL,          -- ISO timestamp of the underlying behavior
      source TEXT NOT NULL,      -- google_search | google_visit | youtube_search | youtube_watch | persona_seed | feedback | app_interaction
      raw_text TEXT,
      dimension TEXT DEFAULT 'recognition',  -- recognition | explain | apply | debug
      direction REAL NOT NULL,   -- signed: + = evidence of knowledge, - = evidence of gap
      strength REAL NOT NULL,    -- 0..1
      interpretation TEXT,       -- short label, e.g. 'seeking_basic_understanding'
      judge TEXT DEFAULT 'heuristic'  -- 'heuristic' | 'jev' | 'fable'
    );
    CREATE INDEX IF NOT EXISTS idx_events_user_concept ON events(user_id, concept_id, ts);

    -- Derived cache of the mastery aggregation (recomputable from events at any time).
    CREATE TABLE IF NOT EXISTS concept_state (
      user_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      mastery REAL NOT NULL,
      confidence REAL NOT NULL,
      evidence_count INTEGER NOT NULL,
      last_positive TEXT,
      last_negative TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, concept_id)
    );

    CREATE TABLE IF NOT EXISTS feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      action TEXT NOT NULL,      -- already_knew | still_confused | more_detail | show_visually
      ts TEXT NOT NULL
    );

    -- Dev-loop cache for model calls (extraction / render replay per smaller-plan budget note).
    CREATE TABLE IF NOT EXISTS model_cache (
      key TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      value TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
  `);

  d.exec(`
    -- Custom-visualization recurrence log: form_slugs that keep appearing are
    -- candidates for promotion into the fixed renderer vocabulary.
    CREATE TABLE IF NOT EXISTS custom_renders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      user_id TEXT NOT NULL,
      concept_id TEXT NOT NULL,
      form_slug TEXT NOT NULL,
      description TEXT
    );
  `);

  // Additive migration: FSRS-style memory dynamics (lib/mastery.ts).
  const cols = (d.prepare("PRAGMA table_info(concept_state)").all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes("stability_days")) d.exec("ALTER TABLE concept_state ADD COLUMN stability_days REAL");
  if (!cols.includes("retrievability")) d.exec("ALTER TABLE concept_state ADD COLUMN retrievability REAL");
}

export function cacheGet(key: string): unknown | null {
  const row = db().prepare("SELECT value FROM model_cache WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : null;
}

export function cachePut(key: string, kind: string, value: unknown) {
  db()
    .prepare("INSERT OR REPLACE INTO model_cache (key, kind, value, created_at) VALUES (?, ?, ?, ?)")
    .run(key, kind, JSON.stringify(value), new Date().toISOString());
}
