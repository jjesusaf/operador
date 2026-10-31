-- Task ledger: source of truth for GET /tasks/:id (the container disk is ephemeral).
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  container_task_id TEXT,
  tarea TEXT NOT NULL,
  desktop_host TEXT,
  estado TEXT NOT NULL,
  resumen TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  forward_error TEXT
);
CREATE INDEX IF NOT EXISTS tasks_created_at ON tasks (created_at);

-- Per-app notebook: navigation facts the agent learned, keyed by a visual fingerprint of the app.
CREATE TABLE IF NOT EXISTS app_notes (
  fingerprint TEXT PRIMARY KEY,
  notes TEXT NOT NULL,
  tasks_seen INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
