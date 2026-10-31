// Cloudflare Worker front door. It owns the public contract (/health, /tasks), the task ledger and the
// per-app notebook (both in D1); the heavy work runs in the container (NestJS API + vision agent).
import { Container, getContainer } from "@cloudflare/containers";
import { Hono } from "hono";
import type { TaskRequest, TaskState, TaskStatusResponse } from "@operador/shared";

export interface Env {
  OPERATOR: DurableObjectNamespace<OperatorContainer>;
  DB: D1Database;
  TEAM_TOKEN: string;
  OPENROUTER_API_KEY: string;
  OPENROUTER_MODEL: string;
  TEAM_NAME: string;
  PUBLIC_URL: string;
  KEEP_ALIVE?: string;
}

interface TaskRow {
  id: string; container_task_id: string | null; tarea: string; desktop_host: string | null;
  estado: TaskState; resumen: string; created_at: number; updated_at: number; forward_error: string | null;
}

const TASK_DEADLINE_MS = 300_000;
const PORT = 8080;

/** Singleton container (the NestJS API with the agent). Lifecycle only; state lives in D1. */
export class OperatorContainer extends Container<Env> {
  defaultPort = PORT;
  sleepAfter = "30m";

  /** With KEEP_ALIVE=1 the container never sleeps: the evaluator must find /health ready at any time. */
  override async onActivityExpired(): Promise<void> {
    if (this.env.KEEP_ALIVE === "1") { console.log("[container] activity expired; KEEP_ALIVE=1, staying up"); return; }
    await this.stop();
  }
  override onStart() { console.log("[container] started"); }
  override onStop(params: any) { console.log("[container] stopped", JSON.stringify(params)); }
  override onError(error: unknown) { console.error("[container] error", error); }

  private containerEnv(): Record<string, string> {
    return {
      NODE_ENV: "production", PORT: String(PORT), DATA_DIR: "/data",
      TEAM_TOKEN: this.env.TEAM_TOKEN, OPENROUTER_API_KEY: this.env.OPENROUTER_API_KEY,
      OPENROUTER_MODEL: this.env.OPENROUTER_MODEL, TEAM_NAME: this.env.TEAM_NAME,
      NOTES_URL: this.env.PUBLIC_URL, // the agent reads/writes its notebook through this Worker
    };
  }

  /** Starts the container with our env and waits until the API answers. Fast no-op when already running. */
  async warm(): Promise<void> {
    await this.startAndWaitForPorts({ ports: PORT, startOptions: { envVars: this.containerEnv() }, cancellationOptions: { portReadyTimeoutMS: 60_000 } });
  }

  async containerStatus(): Promise<string> { return (await this.getState()).status; }

  /** The container's own /health (shows which notebook store it booted with). */
  async apiHealth(): Promise<unknown> {
    const res = await this.containerFetch(`http://container/health`, {}, PORT);
    return res.ok ? await res.json() : { error: `HTTP ${res.status}` };
  }

  /** Kill and relaunch the container so it picks up the current env/secrets. Never call it mid-task. */
  async restart(): Promise<string> {
    try { await this.destroy(); } catch (e) { console.warn("[container] destroy failed", e); }
    await this.warm();
    return (await this.getState()).status;
  }

  /** Hands the task to the container; returns the container's own task id. */
  async forward(req: TaskRequest, authorization: string, receivedAt: number): Promise<string> {
    await this.warm();
    const res = await this.containerFetch(`http://container/tasks`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: authorization, "X-Received-At": String(receivedAt) }, body: JSON.stringify(req) }, PORT);
    if (!res.ok) throw new Error(`container answered HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const { task_id } = await res.json() as { task_id: string };
    return task_id;
  }

  async liveStatus(containerTaskId: string, authorization: string): Promise<TaskStatusResponse | null> {
    const res = await this.containerFetch(`http://container/tasks/${containerTaskId}`, { headers: { Authorization: authorization } }, PORT);
    return res.ok ? (await res.json() as TaskStatusResponse) : null;
  }
}

// ---------- HTTP layer ----------
type AppEnv = { Bindings: Env; Variables: { authorization: string } };
const app = new Hono<AppEnv>();

function authorized(header: string | undefined, expected: string): boolean {
  const token = header?.startsWith("Bearer ") ? header.slice(7).trim() : "";
  if (!token || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

const requireBearer = async (c: any, next: () => Promise<void>) => {
  const header = c.req.header("authorization");
  if (!authorized(header, c.env.TEAM_TOKEN)) return c.json({ error: "invalid or missing bearer token" }, 401);
  c.set("authorization", header!);
  await next();
};

app.get("/health", async (c) => {
  const container = getContainer(c.env.OPERATOR);
  c.executionCtx.waitUntil(container.warm().catch((e) => console.error("[health] warm failed", e)));
  let containerStatus = "unknown";
  try { containerStatus = await container.containerStatus(); } catch (e) { console.error("[health] state failed", e); }
  const counts = await c.env.DB.prepare("SELECT estado, COUNT(*) AS n FROM tasks GROUP BY estado").all<{ estado: string; n: number }>();
  const ledger = Object.fromEntries((counts.results ?? []).map((r) => [r.estado, r.n]));
  return c.json({ status: "ok", team: c.env.TEAM_NAME, version: "0.2.0", models: [c.env.OPENROUTER_MODEL], container: containerStatus, ledger });
});

app.use("/tasks", requireBearer);
app.use("/tasks/*", requireBearer);
app.use("/internal/*", requireBearer);

app.post("/tasks", async (c) => {
  let body: any;
  try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON body" }, 400); }
  const tarea = typeof body?.tarea === "string" ? body.tarea.trim() : "";
  const url = typeof body?.escritorio?.url === "string" ? body.escritorio.url.trim() : "";
  const password = typeof body?.escritorio?.password === "string" ? body.escritorio.password : "";
  if (!tarea) return c.json({ error: "tarea is required" }, 400);
  if (!/^wss?:\/\//.test(url)) return c.json({ error: "escritorio.url must be a ws(s):// URL" }, 400);
  if (!password) return c.json({ error: "escritorio.password is required" }, 400);

  const id = crypto.randomUUID(), now = Date.now();
  let host: string | null = null; try { host = new URL(url).host; } catch {}
  await c.env.DB.prepare("INSERT INTO tasks (id, tarea, desktop_host, estado, resumen, created_at, updated_at) VALUES (?, ?, ?, 'en_curso', '', ?, ?)").bind(id, tarea, host, now, now).run();

  const req: TaskRequest = { tarea, escritorio: { url, password } };
  const auth = c.get("authorization"), db = c.env.DB, container = getContainer(c.env.OPERATOR);
  c.executionCtx.waitUntil((async () => {
    try {
      const containerTaskId = await container.forward(req, auth, now);
      await db.prepare("UPDATE tasks SET container_task_id = ?, updated_at = ? WHERE id = ?").bind(containerTaskId, Date.now(), id).run();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      console.error(`[forward] task ${id} failed: ${msg}`);
      await db.prepare("UPDATE tasks SET estado = 'fallida', resumen = ?, forward_error = ?, updated_at = ? WHERE id = ?")
        .bind("No se pudo iniciar la tarea por un error técnico del servicio; no se hicieron cambios.", msg.slice(0, 500), Date.now(), id).run();
    }
  })());
  return c.json({ task_id: id }, 201);
});

app.get("/tasks/:id", async (c) => {
  const id = c.req.param("id");
  const row = await c.env.DB.prepare("SELECT * FROM tasks WHERE id = ?").bind(id).first<TaskRow>();
  if (!row) return c.json({ error: "unknown task" }, 404);
  let { estado, resumen } = row;
  if (estado === "en_curso" && row.container_task_id) {
    try {
      const live = await getContainer(c.env.OPERATOR).liveStatus(row.container_task_id, c.get("authorization"));
      if (live && (live.estado !== estado || live.resumen !== resumen)) {
        estado = live.estado; resumen = live.resumen;
        await c.env.DB.prepare("UPDATE tasks SET estado = ?, resumen = ?, updated_at = ? WHERE id = ?").bind(estado, resumen, Date.now(), id).run();
      }
    } catch (e) { console.error(`[status] container unreachable for ${id}:`, e); }
  }
  if (estado === "en_curso" && Date.now() - row.created_at > TASK_DEADLINE_MS + 15_000) {
    estado = "fallida"; resumen = resumen || "La tarea no terminó dentro del tiempo límite.";
    await c.env.DB.prepare("UPDATE tasks SET estado = ?, resumen = ?, updated_at = ? WHERE id = ?").bind(estado, resumen, Date.now(), id).run();
  }
  return c.json({ estado, resumen } satisfies TaskStatusResponse);
});

// ---------- internal: per-app notebook used by the agent inside the container ----------
app.get("/internal/notes/:fingerprint", async (c) => {
  const row = await c.env.DB.prepare("SELECT fingerprint, notes, tasks_seen, updated_at FROM app_notes WHERE fingerprint = ?").bind(c.req.param("fingerprint")).first();
  return row ? c.json(row) : c.json({ error: "no notes" }, 404);
});

app.put("/internal/notes/:fingerprint", async (c) => {
  const fp = c.req.param("fingerprint");
  let body: any; try { body = await c.req.json(); } catch { return c.json({ error: "invalid JSON" }, 400); }
  const notes = typeof body?.notes === "string" ? body.notes.slice(0, 4000) : "";
  const tasksSeen = Number.isFinite(body?.tasks_seen) ? Number(body.tasks_seen) : 0;
  await c.env.DB.prepare("INSERT INTO app_notes (fingerprint, notes, tasks_seen, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(fingerprint) DO UPDATE SET notes = excluded.notes, tasks_seen = excluded.tasks_seen, updated_at = excluded.updated_at")
    .bind(fp, notes, tasksSeen, Date.now()).run();
  return c.json({ ok: true });
});

app.get("/internal/container/health", async (c) => c.json(await getContainer(c.env.OPERATOR).apiHealth()));
app.post("/internal/container/restart", async (c) => c.json({ container: await getContainer(c.env.OPERATOR).restart() }));

app.get("/internal/tasks", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, tarea, desktop_host, estado, resumen, created_at, updated_at, forward_error FROM tasks ORDER BY created_at DESC LIMIT 50").all();
  return c.json(rows.results ?? []);
});

export default app;
