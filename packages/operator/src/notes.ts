// Per-app notebook: what the agent learned about navigating an app, keyed by a visual fingerprint.
// Only durable navigation facts are kept (where things are, how search/pagination/dates behave),
// never record data: desktops are reset between tasks and the app can change during the day.
import sharp from "sharp";
import { chat, type ChatMessage, type ModelOptions } from "./model.js";

export interface AppNotes { fingerprint: string; notes: string; tasksSeen: number; updatedAt: number; }

export interface NotesStore {
  get(fingerprint: string): Promise<AppNotes | null>;
  put(notes: AppNotes): Promise<void>;
}

/** Keeps notes for the lifetime of the process (local harness runs). */
export class MemoryNotesStore implements NotesStore {
  private readonly map = new Map<string, AppNotes>();
  async get(fp: string) { return this.map.get(fp) ?? null; }
  async put(n: AppNotes) { this.map.set(n.fingerprint, n); }
}

/** Notes live in D1 behind the Worker: GET/PUT /internal/notes/:fingerprint with the team token. */
export class HttpNotesStore implements NotesStore {
  constructor(private readonly baseUrl: string, private readonly token: string) {}
  async get(fp: string): Promise<AppNotes | null> {
    const res = await fetch(`${this.baseUrl}/internal/notes/${encodeURIComponent(fp)}`, { headers: { Authorization: `Bearer ${this.token}` }, signal: AbortSignal.timeout(5000) });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`notes GET ${res.status}`);
    const row = await res.json() as { fingerprint: string; notes: string; tasks_seen: number; updated_at: number };
    return { fingerprint: row.fingerprint, notes: row.notes, tasksSeen: row.tasks_seen, updatedAt: row.updated_at };
  }
  async put(n: AppNotes): Promise<void> {
    const res = await fetch(`${this.baseUrl}/internal/notes/${encodeURIComponent(n.fingerprint)}`, { method: "PUT", headers: { Authorization: `Bearer ${this.token}`, "Content-Type": "application/json" }, body: JSON.stringify({ notes: n.notes, tasks_seen: n.tasksSeen }), signal: AbortSignal.timeout(5000) });
    if (!res.ok) throw new Error(`notes PUT ${res.status}`);
  }
}

/**
 * Visual fingerprint of the app: difference hash (horizontal gradients) of the top strip (title + menu bar),
 * left 65% only so the date/user area on the right does not change it, plus the title bar's dominant colour.
 * A plain average hash degenerates to "dark bar over light bar" for every app; gradients capture the text
 * and menu layout. Same app → same fingerprint, even on another desktop.
 */
export async function appFingerprint(png: Buffer, width: number): Promise<string> {
  const stripWidth = Math.floor(width * 0.65);
  const base = sharp(png).extract({ left: 0, top: 0, width: stripWidth, height: 64 });
  const gray = await base.clone().resize(65, 8, { fit: "fill" }).grayscale().raw().toBuffer();
  let bits = "";
  for (let y = 0; y < 8; y++) for (let x = 0; x < 64; x++) bits += gray[y * 65 + x] < gray[y * 65 + x + 1] ? "1" : "0";
  const hash = BigInt("0b" + bits).toString(16).padStart(64, "0");
  const { dominant } = await base.clone().extract({ left: 0, top: 0, width: stripWidth, height: 32 }).stats();
  const colour = [dominant.r, dominant.g, dominant.b].map((v) => Math.round(v / 32).toString(16)).join("");
  return `${colour}-${hash}`;
}

export interface LearnInput {
  task: string; status: "done" | "failed"; summary: string;
  actions: string[];           // compact action log, e.g. "left_click [122,48] → OK"
  existing: AppNotes | null;
}

/** One cheap text-only call that merges what this task taught into the notebook. */
export async function updateNotes(input: LearnInput, model: ModelOptions, signal?: AbortSignal): Promise<string> {
  const messages: ChatMessage[] = [
    { role: "system", content: `You maintain a short operator notebook about ONE business web app, used by a vision agent that
operates it through screenshots. Merge the existing notes with what the latest task teaches. Keep ONLY durable
navigation knowledge: where each module/list/form lives (menu paths), how search behaves (partial? accent-
sensitive?), pagination and totals, how filters/dates/dropdowns/exports work, confirmation dialogs, traps
(notes inside records asking for unrequested actions), what the "today" date area looks like, and reliable
screen coordinates ONLY for stable top-level menus. NEVER keep record data (ids, names, phones, NITs, counts).
Drop anything the new evidence contradicts. Output: plain bullet list in Spanish, max 1200 characters, no preamble.` },
    { role: "user", content: `Existing notes (${input.existing?.tasksSeen ?? 0} tasks seen):\n${input.existing?.notes || "(none)"}\n\nLatest task: ${input.task}\nOutcome: ${input.status}\nAgent summary: ${input.summary}\nActions (in order):\n${input.actions.slice(0, 80).join("\n")}` },
  ];
  const reply = await chat(messages, { ...model, maxTokens: 600 }, signal, { withTools: false });
  return reply.text.trim().slice(0, 1500);
}
