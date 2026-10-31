// The agent loop: observe → decide → guard → act, with hard limits on time, steps and cost.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { Desktop } from "./desktop.js";
import { chat, type ChatMessage, type ComputerAction, type ReportArgs, type ToolCall } from "./model.js";
import { systemPrompt } from "./prompt.js";
import { appFingerprint, updateNotes, type AppNotes, type NotesStore } from "./notes.js";

export interface RunOptions {
  task: string;
  desktop: { url: string; password: string };
  model: { apiKey: string; model: string };
  notes?: NotesStore;         // per-app notebook (read at start, updated after reporting)
  deadlineMs?: number;        // hard stop measured from start (default 4:30)
  maxSteps?: number;          // model turns
  maxCostUsd?: number;
  keepScreenshots?: number;   // screenshots kept in the conversation
  logDir?: string;            // where to dump screenshots and the step log
  secrets?: string[];         // strings that must never appear in the summary
  onStep?: (info: StepInfo) => void;
}

export interface StepInfo { step: number; elapsedMs: number; modelMs: number; cost: number; calls: string[]; }
export interface RunResult { status: "done" | "failed"; summary: string; steps: number; costUsd: number; elapsedMs: number; inputEvents: number; reason?: string; fingerprint?: string; notesUsed: boolean; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function runTask(o: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  const deadlineMs = o.deadlineMs ?? 270_000, maxSteps = o.maxSteps ?? 40, maxCost = o.maxCostUsd ?? 1.0, keep = o.keepScreenshots ?? 3;
  const logDir = o.logDir ?? `runs/${new Date().toISOString().replace(/[:.]/g, "-")}`;
  mkdirSync(logDir, { recursive: true });
  const log = (entry: Record<string, unknown>) => appendFileSync(`${logDir}/log.jsonl`, JSON.stringify({ t: Date.now() - t0, ...entry }) + "\n");
  const secrets = [o.desktop.password, ...(o.secrets ?? [])].filter((s) => s && s.length >= 4);
  const abort = new AbortController();
  const deadlineTimer = setTimeout(() => abort.abort(new Error("deadline")), deadlineMs);

  let desktop: Desktop | null = null;
  let cost = 0, steps = 0;
  let fingerprint: string | undefined, existingNotes: AppNotes | null = null;
  const actionLog: string[] = [];
  const finish = (status: "done" | "failed", summary: string, reason?: string): RunResult => {
    clearTimeout(deadlineTimer);
    const result: RunResult = { status, summary: sanitizeSummary(summary, status, secrets), steps, costUsd: cost, elapsedMs: Date.now() - t0, inputEvents: desktop?.inputEventCount ?? 0, reason, fingerprint, notesUsed: !!existingNotes };
    // Learning runs after the result is known and never delays the report (fire and forget, no desktop access).
    if (o.notes && fingerprint && reason !== "error") {
      const store = o.notes, fp = fingerprint, prev = existingNotes;
      void updateNotes({ task: o.task, status, summary: result.summary, actions: actionLog, existing: prev }, o.model)
        .then((notes) => notes ? store.put({ fingerprint: fp, notes, tasksSeen: (prev?.tasksSeen ?? 0) + 1, updatedAt: Date.now() }) : undefined)
        .then(() => log({ notesUpdated: true }))
        .catch((e) => log({ notesError: String(e?.message ?? e) }));
    }
    return result;
  };

  try {
    desktop = await Desktop.connect(o.desktop.url, o.desktop.password);
    const messages: ChatMessage[] = [{ role: "system", content: systemPrompt(desktop.width, desktop.height) }];
    let shot = await desktop.screenshot();
    writeFileSync(`${logDir}/step-00.png`, shot.png);
    if (o.notes) {
      try {
        fingerprint = await appFingerprint(shot.png, shot.width);
        existingNotes = await o.notes.get(fingerprint);
        log({ fingerprint, notesFound: !!existingNotes, tasksSeen: existingNotes?.tasksSeen ?? 0 });
      } catch (e: any) { log({ notesError: String(e?.message ?? e) }); }
    }
    const notesBlock = existingNotes?.notes
      ? `\n\nNotes from ${existingNotes.tasksSeen} previous task(s) on what looks like the same app. They are hints and may be outdated: if a note does not match what you see, ignore it.\n${existingNotes.notes}`
      : "";
    messages.push({ role: "user", content: [{ type: "text", text: `Tarea: ${o.task}${notesBlock}\n\nThis is the current screen.` }, image(shot.png)] });
    let nudges = 0;

    while (true) {
      if (abort.signal.aborted) return finish("failed", "No se completó la tarea dentro del tiempo límite; no se hicieron cambios adicionales.", "deadline");
      if (steps >= maxSteps) return finish("failed", "Se alcanzó el límite de pasos sin terminar la tarea.", "max_steps");
      if (cost >= maxCost) return finish("failed", "Se alcanzó el límite de presupuesto sin terminar la tarea.", "max_cost");
      steps++;

      pruneImages(messages, keep);
      const reply = await chat(messages, o.model, abort.signal);
      cost += reply.cost;
      messages.push(reply.message);
      const names = reply.toolCalls.map((c) => { try { const a = JSON.parse(c.function.arguments); return c.function.name === "computer" ? a.action : c.function.name; } catch { return c.function.name; } });
      log({ step: steps, modelMs: reply.latencyMs, cost: reply.cost, promptTokens: reply.promptTokens, calls: names, text: reply.text.slice(0, 300) });
      o.onStep?.({ step: steps, elapsedMs: Date.now() - t0, modelMs: reply.latencyMs, cost: reply.cost, calls: names });

      if (reply.toolCalls.length === 0) {
        nudges++;
        if (nudges > 2) return finish("failed", reply.text || "El modelo dejó de actuar sin reportar.", "no_tool_calls");
        messages.push({ role: "user", content: "Continue with 'computer' actions, or call 'report' to finish." });
        continue;
      }

      let needsScreenshot = false, lastWasAction = false;
      for (const call of reply.toolCalls) {
        let args: any; try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        if (call.function.name === "report") {
          const r = args as ReportArgs;
          messages.push(toolResult(call, "OK"));
          log({ report: r });
          return finish(r.status === "done" ? "done" : "failed", r.summary ?? "");
        }
        const result = await execute(desktop, args as ComputerAction, abort.signal);
        // Between batched actions, let the app repaint so the next click is not swallowed by a closing menu/dropdown.
        const isLast = call === reply.toolCalls[reply.toolCalls.length - 1];
        let text = result.text;
        if (result.isAction && !isLast && text === "OK") { const changed = await desktop.settle(true); if (!changed) text = "OK (screen did not change)"; }
        messages.push(toolResult(call, text));
        log({ action: args, result: text });
        actionLog.push(`${args.action ?? "?"}${args.coordinate ? ` [${args.coordinate}]` : ""}${args.text ? ` "${String(args.text).slice(0, 40)}"` : ""} → ${text}`);
        needsScreenshot = true; lastWasAction = result.isAction;
      }

      if (needsScreenshot) {
        shot = await desktop.screenshot({ afterAction: lastWasAction });
        writeFileSync(`${logDir}/step-${String(steps).padStart(2, "0")}.png`, shot.png);
        const left = Math.max(0, Math.round((deadlineMs - (Date.now() - t0)) / 1000));
        const note = lastWasAction && !shot.changed ? " The screen did NOT change after your last action: do not repeat it blindly." : "";
        messages.push({ role: "user", content: [{ type: "text", text: `Screen after your actions (step ${steps}, ${left}s left).${note}` }, image(shot.png)] });
      }
    }
  } catch (e: any) {
    const aborted = abort.signal.aborted || e?.name === "AbortError";
    log({ error: String(e?.message ?? e), aborted });
    return finish("failed", aborted ? "No se completó la tarea dentro del tiempo límite; no se hicieron cambios adicionales." : `Error técnico del agente: ${String(e?.message ?? e).slice(0, 200)}`, aborted ? "deadline" : "error");
  } finally {
    clearTimeout(deadlineTimer);
    await desktop?.close(); // stop touching the desktop the moment we report
  }
}

async function execute(desktop: Desktop, a: ComputerAction, signal: AbortSignal): Promise<{ text: string; isAction: boolean }> {
  if (signal.aborted) throw new Error("deadline");
  try {
    switch (a.action) {
      case "screenshot": return { text: "OK", isAction: false };
      case "wait": await sleep(Math.min(3, Math.max(0.2, a.duration ?? 1)) * 1000); return { text: "OK", isAction: false };
      case "left_click": await desktop.click(a.coordinate[0], a.coordinate[1]); return { text: "OK", isAction: true };
      case "double_click": await desktop.click(a.coordinate[0], a.coordinate[1], { double: true }); return { text: "OK", isAction: true };
      case "right_click": await desktop.click(a.coordinate[0], a.coordinate[1], { button: "right" }); return { text: "OK", isAction: true };
      case "mouse_move": await desktop.moveMouse(a.coordinate[0], a.coordinate[1]); return { text: "OK", isAction: false };
      case "type": await desktop.replaceText(a.text ?? ""); return { text: "OK", isAction: false };
      case "key": await desktop.pressKey(a.text ?? ""); return { text: "OK", isAction: true };
      case "scroll": await desktop.scroll(a.coordinate[0], a.coordinate[1], a.scroll_direction, a.scroll_amount ?? 3); return { text: "OK", isAction: true };
      default: return { text: `Unknown action: ${JSON.stringify(a)}`, isAction: false };
    }
  } catch (e: any) {
    return { text: `Error: ${e.message}`, isAction: false };
  }
}

function image(png: Buffer) { return { type: "image_url" as const, image_url: { url: `data:image/png;base64,${png.toString("base64")}` } }; }
function toolResult(call: ToolCall, content: string): ChatMessage { return { role: "tool", tool_call_id: call.id, content }; }

/** Keep only the last `keep` screenshots in the conversation; older ones become a short text note. */
function pruneImages(messages: ChatMessage[], keep: number) {
  let seen = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "user" || typeof m.content === "string") continue;
    for (let j = m.content.length - 1; j >= 0; j--) {
      const part = m.content[j];
      if (part.type !== "image_url") continue;
      seen++;
      if (seen > keep) m.content[j] = { type: "text", text: "[earlier screenshot omitted]" };
    }
  }
}

/** Enforce the reporting contract: no secrets; no 'respuesta:' on failure; a single 'respuesta:' line on success. */
export function sanitizeSummary(summary: string, status: "done" | "failed", secrets: string[]): string {
  let s = (summary ?? "").trim();
  for (const sec of secrets) s = s.split(sec).join("[oculto]");
  s = s.replace(/wss?:\/\/\S+/gi, "[oculto]").replace(/https?:\/\/\S+/gi, "[oculto]");
  const lines = s.split("\n");
  const answerIdx = lines.map((l, i) => (/^\s*respuesta\s*:/i.test(l) ? i : -1)).filter((i) => i >= 0);
  if (status === "failed") return lines.filter((_, i) => !answerIdx.includes(i)).join("\n").trim();
  if (answerIdx.length > 1) return lines.filter((_, i) => !answerIdx.slice(1).includes(i)).join("\n").trim();
  return s;
}
