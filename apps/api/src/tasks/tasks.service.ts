import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { runTask, HttpNotesStore, MemoryNotesStore, type NotesStore } from "@operador/operator";
import type { TaskRecord, TaskRequest, TaskStatusResponse } from "@operador/shared";
import { ConfigService } from "../config.service.js";
import { TasksRepository } from "./tasks.repository.js";

interface Queued { id: string; req: TaskRequest; receivedAt: number; }

/** Host of the desktop URL (password and path are irrelevant for exclusivity). */
function desktopKey(url: string): string {
  try { return new URL(url).host.toLowerCase(); } catch { return url; }
}

/** Accepts tasks instantly and runs them in the background with bounded concurrency. */
@Injectable()
export class TasksService implements OnModuleDestroy {
  private readonly log = new Logger(TasksService.name);
  private readonly queue: Queued[] = [];
  private running = 0;
  private shuttingDown = false;

  private readonly notes: NotesStore;

  constructor(private readonly config: ConfigService, private readonly repo: TasksRepository) {
    this.notes = config.notesUrl ? new HttpNotesStore(config.notesUrl, config.teamToken) : new MemoryNotesStore();
    this.log.log(`notebook store: ${config.notesUrl ? `D1 via ${config.notesUrl}` : "in-memory"}`);
  }

  /** Must return in well under 2 s: only persists and enqueues. */
  submit(req: TaskRequest, receivedAt: number = Date.now()): { task_id: string } {
    const id = randomUUID();
    this.repo.create({ id, tarea: req.tarea, desktopUrl: req.escritorio.url });
    this.queue.push({ id, req, receivedAt });
    this.log.log(`task ${id} queued (${this.queue.length} waiting, ${this.running} running)`);
    setImmediate(() => this.pump());
    return { task_id: id };
  }

  status(id: string): TaskStatusResponse | undefined {
    const rec = this.repo.get(id);
    return rec ? { estado: rec.estado, resumen: rec.resumen } : undefined;
  }

  record(id: string): TaskRecord | undefined { return this.repo.get(id); }

  stats() { return { queued: this.queue.length, running: this.running, ...this.repo.counts() }; }

  /** Desktops with a task in flight: two tasks on the same desktop would trample each other's screen. */
  private readonly busyDesktops = new Set<string>();

  private pump() {
    while (!this.shuttingDown && this.running < this.config.maxConcurrentTasks) {
      const idx = this.queue.findIndex((q) => !this.busyDesktops.has(desktopKey(q.req.escritorio.url)));
      if (idx < 0) break; // nothing runnable: every queued task targets a busy desktop
      const [next] = this.queue.splice(idx, 1);
      const key = desktopKey(next.req.escritorio.url);
      this.running++; this.busyDesktops.add(key);
      this.execute(next)
        .catch((e) => this.log.error(`task ${next.id} crashed: ${e?.message ?? e}`))
        .finally(() => { this.running--; this.busyDesktops.delete(key); this.pump(); });
    }
  }

  private async execute({ id, req, receivedAt }: Queued) {
    // The deadline counts from the moment the evaluator posted the task, not from when we picked it up.
    const remaining = this.config.taskDeadlineMs - (Date.now() - receivedAt);
    if (remaining < 15_000) {
      this.repo.finish(id, "fallida", "No se completó la tarea dentro del tiempo límite; no se hicieron cambios.", { steps: 0, costUsd: 0, reason: "queue_timeout" });
      return;
    }
    this.log.log(`task ${id} started (${Math.round(remaining / 1000)}s budget)`);
    const result = await runTask({
      task: req.tarea,
      desktop: { url: req.escritorio.url, password: req.escritorio.password },
      model: { apiKey: this.config.openRouterApiKey, model: this.config.model },
      notes: this.notes,
      deadlineMs: remaining,
      maxCostUsd: this.config.maxCostPerTaskUsd,
      logDir: join(this.config.dataDir, "runs", id),
      secrets: [this.config.teamToken, req.escritorio.url],
      onStep: (s) => this.log.debug?.(`task ${id} step ${s.step} ${s.calls.join(",")} ${s.modelMs}ms $${s.cost.toFixed(4)}`),
    });
    this.repo.finish(id, result.status === "done" ? "terminada" : "fallida", result.summary, { steps: result.steps, costUsd: result.costUsd, reason: result.reason });
    this.log.log(`task ${id} ${result.status} in ${(result.elapsedMs / 1000).toFixed(1)}s, ${result.steps} steps, $${result.costUsd.toFixed(3)}${result.reason ? ` (${result.reason})` : ""}`);
  }

  onModuleDestroy() { this.shuttingDown = true; }
}
