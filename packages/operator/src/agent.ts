// The agent loop: observe → decide → guard → act, with hard limits on time, steps and cost.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { Desktop } from "./desktop.js";
import { chat, calculate, type ChatMessage, type ComputerAction, type ReportArgs, type ToolCall } from "./model.js";
import { systemPrompt } from "./prompt.js";
import { appFingerprint, updateNotes, type AppNotes, type NotesStore } from "./notes.js";

export interface RunOptions {
  task: string;
  desktop: { url: string; password: string };
  model: { apiKey: string; model: string; fastModel?: string }; // fastModel: simple tasks + notebook upkeep
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
export interface RunResult { status: "done" | "failed"; summary: string; steps: number; costUsd: number; elapsedMs: number; inputEvents: number; reason?: string; fingerprint?: string; notesUsed: boolean; model: string; }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Tasks with several parts or conditions get a text-only planning turn before any action. */
export function needsPlan(task: string): boolean {
  const t = task.toLowerCase();
  // Long instructions, or ones with conditions / sequencing words. (No sentence counting: "Dra." would trigger it.)
  return t.length > 140 || /\bsi\b|\bluego\b|\bdespués\b|\bdespues\b|\bprimero\b|\bantes de\b|\bmism[oa]\b|\bdeshaz|\brevierte|\bbitácora|\bbitacora|\by (?:anula|agenda|agéndale|factura|cancela|registra|dale|déjala|dejala)\b|ag[eé]nd|\bcupo|lista de espera|reactiv|autorizaci[oó]n|\btotal\b|en total/.test(t);
}

export async function runTask(input: RunOptions): Promise<RunResult> {
  const t0 = Date.now();
  // Route by difficulty: chained/conditional tasks get the strong model, simple ones the fast/cheap one.
  const complex = needsPlan(input.task);
  const taskModel = !complex && input.model.fastModel ? input.model.fastModel : input.model.model;
  const o: RunOptions = { ...input, model: { ...input.model, model: taskModel } };
  const notesModel = { apiKey: input.model.apiKey, model: input.model.fastModel || input.model.model };
  const deadlineMs = o.deadlineMs ?? 270_000, maxSteps = o.maxSteps ?? 60, maxCost = o.maxCostUsd ?? 1.5, keep = o.keepScreenshots ?? 2;
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
  const facts: string[] = []; // the agent's own notes for this task (survive screenshot pruning)
  const messages: ChatMessage[] = [];

  const finish = (status: "done" | "failed", summary: string, reason?: string): RunResult => {
    clearTimeout(deadlineTimer);
    const result: RunResult = { status, summary: sanitizeSummary(summary, status, secrets), steps, costUsd: cost, elapsedMs: Date.now() - t0, inputEvents: desktop?.inputEventCount ?? 0, reason, fingerprint, notesUsed: !!existingNotes, model: taskModel };
    // Learning runs after the result is known and never delays the report (fire and forget, no desktop access).
    if (o.notes && fingerprint && reason !== "error") {
      const store = o.notes, fp = fingerprint, prev = existingNotes;
      void updateNotes({ task: o.task, status, summary: result.summary, actions: actionLog, existing: prev }, notesModel)
        .then((notes) => notes ? store.put({ fingerprint: fp, notes, tasksSeen: (prev?.tasksSeen ?? 0) + 1, updatedAt: Date.now() }) : undefined)
        .then(() => log({ notesUpdated: true }))
        .catch((e) => log({ notesError: String(e?.message ?? e) }));
    }
    return result;
  };

  /** When a hard limit stops the loop, ask for a short final summary so the report still names what was found. */
  const finishOnLimit = async (reason: string, fallback: string): Promise<RunResult> => {
    await desktop?.close(); // stop touching the desktop first
    try {
      const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), 12_000);
      const tail = messages.filter((m) => m.role !== "system").slice(-6).map((m) => (m.role === "user" && typeof m.content !== "string") ? { ...m, content: m.content.filter((p) => p.type === "text") } : m);
      const reply = await chat([
        { role: "system", content: "You are the same operator. The task was stopped by a hard limit. Write the final report in Spanish, 2-4 sentences: what you managed to find or do (name concrete data: ids, names, dates, references), what was pending, and that no further changes were made. No 'respuesta:' line unless you are certain of the answer. Never include passwords, tokens or URLs." },
        ...(facts.length ? [{ role: "user" as const, content: `Your notes during the task:\n${facts.map((f) => `- ${f}`).join("\n")}` }] : []),
        ...tail,
        { role: "user", content: `Stopped: ${reason}. Write the final report now.` },
      ], { ...o.model, maxTokens: 400 }, ctrl.signal, { withTools: false });
      clearTimeout(t); cost += reply.cost;
      if (reply.text.trim()) return finish("failed", reply.text.trim(), reason);
    } catch (e: any) { log({ finalSummaryError: String(e?.message ?? e) }); }
    return finish("failed", fallback, reason);
  };

  const factsBlock = () => facts.length ? `\n\nYour notes so far:\n${facts.map((f, i) => `${i + 1}. ${f}`).join("\n")}` : "";

  try {
    desktop = await Desktop.connect(o.desktop.url, o.desktop.password);
    // The system prompt (and the tool definitions before it) is identical on every turn: mark it cacheable
    // so Anthropic's prompt cache (through OpenRouter) stops charging for it after the first turn.
    messages.push({ role: "system", content: [{ type: "text", text: systemPrompt(desktop.width, desktop.height), cache_control: { type: "ephemeral" } }] });
    let shot = await desktop.screenshot();
    writeFileSync(`${logDir}/step-00.png`, shot.png);
    if (o.notes) {
      try {
        fingerprint = await appFingerprint(shot.png, shot.width);
        existingNotes = await o.notes.get(fingerprint);
        log({ fingerprint, notesFound: !!existingNotes, tasksSeen: existingNotes?.tasksSeen ?? 0, model: taskModel, complex });
      } catch (e: any) { log({ notesError: String(e?.message ?? e) }); }
    }
    const notesBlock = existingNotes?.notes
      ? `\n\nNotes from ${existingNotes.tasksSeen} previous task(s) on what looks like the same app. They are hints and may be outdated (the app's theme, labels and layout can change): if a note does not match what you see, ignore it.\n${existingNotes.notes}`
      : "";
    const plan = needsPlan(o.task);
    messages.push({ role: "user", content: [{ type: "text", text: `Tarea: ${o.task}${notesBlock}\n\nThis is the current screen.${plan ? "\n\nThis task has several parts or conditions. Before any action, reply with a short plan (no tool calls): the app's 'today' date if visible, the entities to locate, the checks to make, the actions in order, and what 'done' looks like." : ""}` }, image(shot.png)] });
    let nudges = 0, planPending = plan, emptyReports = 0;
    const recentSignatures: string[] = []; // action batches of the last turns, to detect loops

    while (true) {
      if (abort.signal.aborted) return finishOnLimit("deadline", "No se completó la tarea dentro del tiempo límite; no se hicieron cambios adicionales.");
      if (steps >= maxSteps) return finishOnLimit("max_steps", "Se alcanzó el límite de pasos sin terminar la tarea.");
      if (cost >= maxCost) return finishOnLimit("max_cost", "Se alcanzó el límite de presupuesto sin terminar la tarea.");
      steps++;

      pruneImages(messages, keep);
      markCacheBoundary(messages);
      const reply = await chat(messages, o.model, abort.signal, planPending ? { toolChoice: "none" } : {});
      cost += reply.cost;
      messages.push(reply.message);
      if (reply.text) actionLog.push(`[plan/thought] ${reply.text.slice(0, 200)}`);
      const names = reply.toolCalls.map((c) => { try { const a = JSON.parse(c.function.arguments); return c.function.name === "computer" ? a.action : c.function.name; } catch { return c.function.name; } });
      log({ step: steps, modelMs: reply.latencyMs, cost: reply.cost, promptTokens: reply.promptTokens, cachedTokens: reply.cachedTokens, calls: names, text: reply.text.slice(0, 400) });
      o.onStep?.({ step: steps, elapsedMs: Date.now() - t0, modelMs: reply.latencyMs, cost: reply.cost, calls: names });

      if (planPending) {
        planPending = false;
        if (reply.text.trim()) facts.push(`Plan: ${reply.text.trim().replace(/\s+/g, " ").slice(0, 700)}`);
        messages.push({ role: "user", content: "Good. Now execute the plan step by step. Use 'note' for every key fact you read." });
        continue;
      }

      if (reply.toolCalls.length === 0) {
        nudges++;
        if (nudges > 2) return finish("failed", reply.text || "El modelo dejó de actuar sin reportar.", "no_tool_calls");
        messages.push({ role: "user", content: "Continue with 'computer' actions, or call 'report' to finish." });
        continue;
      }

      // Loop guard: the same batch of screen actions over and over means the approach is not working.
      const signature = reply.toolCalls.filter((c) => c.function.name === "computer").map((c) => {
        try { const a = JSON.parse(c.function.arguments || "{}"); return `${a.action}:${a.coordinate ?? ""}:${a.text ?? ""}`; } catch { return c.function.arguments; }
      }).filter((s) => !s.startsWith("screenshot") && !s.startsWith("zoom") && !s.startsWith("wait")).join("|");
      let loopWarning = "";
      if (signature) {
        recentSignatures.push(signature);
        if (recentSignatures.length > 10) recentSignatures.shift();
        const repeats = recentSignatures.filter((s) => s === signature).length;
        if (repeats >= 5) { log({ loop: signature, repeats }); return finishOnLimit("loop", "La acción necesaria no tuvo efecto tras varios intentos; no se completó la tarea."); }
        if (repeats >= 3) loopWarning = ` LOOP WARNING: you have done exactly this ${repeats} times and it is not working. Do NOT repeat it. Read the screen for an error or confirmation message, try a genuinely different approach, or, if the app does not allow it, call report with status "failed" explaining exactly why (what you tried and what the app showed).`;
      }

      // Guard: 'report' must come alone, after looking at the result. If it is mixed with actions, run the
      // actions, show the screen, and let the model report on the next turn.
      const hasActions = reply.toolCalls.some((c) => c.function.name === "computer");
      let needsScreenshot = false, lastWasAction = false;
      const zooms: Buffer[] = [];
      for (const call of reply.toolCalls) {
        let args: any; try { args = JSON.parse(call.function.arguments || "{}"); } catch { args = {}; }
        switch (call.function.name) {
          case "report": {
            if (hasActions) { messages.push(toolResult(call, "Not accepted: 'report' must be called alone, after you have seen the screen following your last action. Look at the next screenshot, verify, then report.")); log({ reportRejected: true }); break; }
            const r = args as ReportArgs;
            if ((r.status !== "done" && r.status !== "failed") || !String(r.summary ?? "").trim()) {
              emptyReports++;
              log({ reportRejected: "empty", args: r });
              if (emptyReports >= 2) return finishOnLimit("empty_report", "No se completó la tarea.");
              messages.push(toolResult(call, "Not accepted: 'report' needs status ('done' or 'failed') AND a summary in Spanish explaining what you did, what you found and, if failed, exactly why (name the data). Call report again with both."));
              break;
            }
            messages.push(toolResult(call, "OK"));
            log({ report: r });
            return finish(r.status === "done" ? "done" : "failed", r.summary ?? "");
          }
          case "note": {
            const text = String(args.text ?? "").trim().slice(0, 300);
            if (text) facts.push(text);
            messages.push(toolResult(call, text ? `Noted (${facts.length} notes).` : "Empty note ignored."));
            log({ note: text });
            break;
          }
          case "calc": {
            const out = calculate(args.expression);
            messages.push(toolResult(call, out));
            log({ calc: args.expression, result: out });
            break;
          }
          case "computer": {
            if (args.action === "zoom") {
              const zr = await desktop.zoom(args.region);
              if (zr) { zooms.push(zr); messages.push(toolResult(call, "Zoomed image attached below.")); }
              else messages.push(toolResult(call, "Error: region must be [x, y, width, height] inside the screen."));
              log({ action: args, result: zr ? "zoom" : "zoom error" });
              break;
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
            break;
          }
          default:
            messages.push(toolResult(call, `Unknown tool ${call.function.name}`));
        }
      }

      if (needsScreenshot || zooms.length || hasActions) {
        shot = await desktop.screenshot({ afterAction: lastWasAction });
        writeFileSync(`${logDir}/step-${String(steps).padStart(2, "0")}.png`, shot.png);
        const left = Math.max(0, Math.round((deadlineMs - (Date.now() - t0)) / 1000));
        const note = lastWasAction && !shot.changed ? " The screen did NOT change after your last action: do not repeat it blindly." : "";
        const budget = steps >= maxSteps - 25 || left <= 75
          ? ` Budget warning: ${maxSteps - steps} turns and ${left}s left. If you are not clearly making progress, verify what you have done and call report (status "failed" if the task is not complete, naming what you found).`
          : "";
        const content: Extract<ChatMessage, { role: "user" }>["content"] = [{ type: "text", text: `Screen after your actions (step ${steps}, ${left}s left).${note}${loopWarning}${budget}${factsBlock()}` }, image(shot.png)];
        for (const z of zooms) content.push({ type: "text", text: "Zoomed region:" }, image(z));
        messages.push({ role: "user", content });
      } else {
        // Only notes/calc this turn: no new screen, but keep the facts visible.
        messages.push({ role: "user", content: `Continue.${loopWarning}${factsBlock()}` });
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

/**
 * Incremental prompt caching. The conversation is append-only except for pruned screenshots, so the prefix that
 * ends right before the oldest screenshot still in context is byte-stable from one turn to the next. Put the cache
 * breakpoint at the end of the last user message inside that prefix (the system prompt keeps its own breakpoint);
 * the provider's lookback finds the entry written on the previous turn and bills that prefix at the cached rate.
 */
function markCacheBoundary(messages: ChatMessage[]) {
  for (const m of messages) {
    if (m.role === "user" && typeof m.content !== "string") for (const p of m.content) if (p.type === "text") delete p.cache_control;
  }
  const firstImage = messages.findIndex((m) => m.role === "user" && typeof m.content !== "string" && m.content.some((p) => p.type === "image_url"));
  const limit = firstImage < 0 ? messages.length : firstImage;
  for (let i = limit - 1; i > 0; i--) {
    const m = messages[i];
    if (m.role !== "user") continue;
    if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }];
    const texts = m.content.filter((p) => p.type === "text");
    if (texts.length) { (texts[texts.length - 1] as { cache_control?: { type: "ephemeral" } }).cache_control = { type: "ephemeral" }; return; }
  }
}

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

/** Enforce the reporting contract: no secrets; no 'respuesta:' on failure; a single 'respuesta:' line on success; numbers without thousands separators. */
export function sanitizeSummary(summary: string, status: "done" | "failed", secrets: string[]): string {
  let s = (summary ?? "").trim();
  for (const sec of secrets) s = s.split(sec).join("[oculto]");
  s = s.replace(/wss?:\/\/\S+/gi, "[oculto]").replace(/https?:\/\/\S+/gi, "[oculto]");
  const lines = s.split("\n");
  const answerIdx = lines.map((l, i) => (/^\s*respuesta\s*:/i.test(l) ? i : -1)).filter((i) => i >= 0);
  if (status === "failed") return lines.filter((_, i) => !answerIdx.includes(i)).join("\n").trim();
  if (answerIdx.length > 1) { const keepIdx = answerIdx[0]; for (const i of answerIdx.slice(1)) lines[i] = ""; answerIdx.length = 1; answerIdx[0] = keepIdx; }
  if (answerIdx.length === 1) {
    // "respuesta: $ 1.250.000" → "respuesta: 1250000": the evaluator parses the first number on the line.
    const i = answerIdx[0];
    lines[i] = lines[i].replace(/^(\s*respuesta\s*:\s*)(.*)$/i, (_m, head: string, rest: string) => head + rest.replace(/\$\s*/g, "").replace(/(\d)[.,](?=\d{3}(\D|$))/g, "$1"));
  }
  return lines.filter((l, i) => !(l === "" && i > 0 && answerIdx.length && i !== answerIdx[0] && lines[i] === "")).join("\n").trim();
}
