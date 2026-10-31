import { Injectable, OnModuleDestroy } from "@nestjs/common";
import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TaskRecord, TaskState } from "@operador/shared";
import { ConfigService } from "../config.service.js";

/** SQLite-backed task store so GET /tasks/:id survives a process restart. */
@Injectable()
export class TasksRepository implements OnModuleDestroy {
  private readonly db: Database.Database;

  constructor(config: ConfigService) {
    mkdirSync(config.dataDir, { recursive: true });
    this.db = new Database(join(config.dataDir, "tasks.sqlite"));
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY, tarea TEXT NOT NULL, desktop_url TEXT NOT NULL,
      estado TEXT NOT NULL, resumen TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      steps INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0, reason TEXT
    )`);
    // Tasks left "en_curso" by a crash/restart can never finish: report them honestly as failed.
    this.db.prepare(`UPDATE tasks SET estado='fallida', reason='restart', updated_at=?, resumen=CASE WHEN resumen='' THEN 'El servicio se reinició antes de terminar la tarea; no se completó.' ELSE resumen END WHERE estado='en_curso'`).run(Date.now());
  }

  create(rec: Pick<TaskRecord, "id" | "tarea" | "desktopUrl">): TaskRecord {
    const now = Date.now();
    this.db.prepare(`INSERT INTO tasks (id, tarea, desktop_url, estado, resumen, created_at, updated_at) VALUES (?, ?, ?, 'en_curso', '', ?, ?)`).run(rec.id, rec.tarea, rec.desktopUrl, now, now);
    return this.get(rec.id)!;
  }

  finish(id: string, estado: Exclude<TaskState, "en_curso">, resumen: string, extra: { steps: number; costUsd: number; reason?: string }) {
    this.db.prepare(`UPDATE tasks SET estado=?, resumen=?, steps=?, cost_usd=?, reason=?, updated_at=? WHERE id=?`).run(estado, resumen, extra.steps, extra.costUsd, extra.reason ?? null, Date.now(), id);
  }

  get(id: string): TaskRecord | undefined {
    const r = this.db.prepare(`SELECT * FROM tasks WHERE id=?`).get(id) as any;
    if (!r) return undefined;
    return { id: r.id, tarea: r.tarea, desktopUrl: r.desktop_url, estado: r.estado, resumen: r.resumen, createdAt: r.created_at, updatedAt: r.updated_at, steps: r.steps, costUsd: r.cost_usd, reason: r.reason ?? undefined };
  }

  counts(): Record<string, number> {
    const rows = this.db.prepare(`SELECT estado, COUNT(*) AS n FROM tasks GROUP BY estado`).all() as Array<{ estado: string; n: number }>;
    return Object.fromEntries(rows.map((r) => [r.estado, r.n]));
  }

  onModuleDestroy() { this.db.close(); }
}
