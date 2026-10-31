// Desktop connector: eyes (screenshots) and hands (mouse/keyboard) over VNC via WebSocket.
// No browser involved: rfb2 speaks RFB directly over the websockify WebSocket stream.
import WebSocket, { createWebSocketStream } from "ws";
import { connect, Framebuffer, buttons, keysyms, keysymFromChar, type RfbClient } from "rfb2";
import sharp from "sharp";

// X11 keysyms that rfb2 does not export by name.
const KEYSYMS: Record<string, number> = {
  ...(keysyms as Record<string, number>),
  Control_L: 0xffe3, Shift_L: 0xffe1, Alt_L: 0xffe9, Super_L: 0xffeb,
  Page_Up: 0xff55, Page_Down: 0xff56, space: 0x20, Insert: 0xff63,
  F1: 0xffbe, F2: 0xffbf, F3: 0xffc0, F4: 0xffc1, F5: 0xffc2, F6: 0xffc3, F7: 0xffc4, F8: 0xffc5, F9: 0xffc6, F10: 0xffc7, F11: 0xffc8, F12: 0xffc9,
};
// Friendly aliases (what a model usually emits).
const ALIASES: Record<string, string> = {
  enter: "Return", return: "Return", tab: "Tab", esc: "Escape", escape: "Escape", backspace: "BackSpace",
  delete: "Delete", del: "Delete", up: "Up", down: "Down", left: "Left", right: "Right", home: "Home", end: "End",
  pageup: "Page_Up", pagedown: "Page_Down", page_up: "Page_Up", page_down: "Page_Down", space: "space",
  ctrl: "Control_L", control: "Control_L", shift: "Shift_L", alt: "Alt_L", super: "Super_L", cmd: "Super_L", meta: "Super_L", win: "Super_L",
};
// Key combos that could close or reload the kiosk browser: never sent.
const FORBIDDEN_KEYS = new Set(["ctrl+w", "ctrl+q", "ctrl+r", "ctrl+t", "ctrl+n", "ctrl+shift+q", "ctrl+shift+w", "ctrl+shift+n", "ctrl+shift+t", "alt+f4", "f5", "ctrl+f5", "shift+f5", "f11", "f12", "ctrl+shift+i", "ctrl+shift+j", "ctrl+l", "alt+left", "alt+right", "alt+home", "ctrl+shift+delete"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface DesktopOptions {
  clickHoldMs?: number;      // time between button down and up (server ignores < 100 ms)
  keyDelayMs?: number;       // delay between key events
  settleMaxMs?: number;      // max wait for the screen to settle
  settleThreshold?: number;  // fraction of changed pixels still considered "settled"
  quietMs?: number;          // no updates for this long = settled
}

export interface Screenshot { png: Buffer; width: number; height: number; waitMs: number; changed: boolean; }

export class Desktop {
  private inputEvents = 0;
  private closed = false;
  private constructor(private ws: WebSocket, private client: RfbClient, private fb: Framebuffer, private opt: Required<DesktopOptions>) {}

  static async connect(wssUrl: string, password: string, options: DesktopOptions = {}): Promise<Desktop> {
    const opt: Required<DesktopOptions> = { clickHoldMs: 200, keyDelayMs: 25, settleMaxMs: 1500, settleThreshold: 0.002, quietMs: 250, ...options };
    const ws = new WebSocket(wssUrl, ["binary"], { perMessageDeflate: false });
    await new Promise<void>((res, rej) => { ws.once("open", () => res()); ws.once("error", rej); });
    const client = await connect({ stream: createWebSocketStream(ws, { objectMode: false }), password, timeout: 10_000, initialUpdate: true });
    const fb = Framebuffer.attach(client);
    const desktop = new Desktop(ws, client, fb, opt);
    client.on("error", (e: Error) => console.error("[desktop] rfb error:", e.message));
    await desktop.waitForFullScreen();
    return desktop;
  }

  get width() { return this.client.width; }
  get height() { return this.client.height; }
  /** Input events sent so far (lets the harness verify "zero actions after reporting"). */
  get inputEventCount() { return this.inputEvents; }

  private async waitForFullScreen() {
    const total = this.width * this.height; let covered = 0, n = 0; const t = Date.now();
    while (covered < total && Date.now() - t < 8000) {
      this.client.requestUpdate(n > 0, 0, 0, this.width, this.height);
      const u = await this.client.nextUpdate(); n++;
      covered += u.rects.filter((r: any) => r.type === "pixels").reduce((a: number, r: any) => a + r.width * r.height, 0);
    }
  }

  private changedFraction(a: Buffer, b: Buffer): number {
    let diff = 0; const n = Math.min(a.length, b.length);
    for (let i = 0; i < n; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) diff++;
    return diff / (n / 4);
  }

  /** Waits for the screen to settle after an action, without encoding a screenshot. */
  async settle(afterAction = true): Promise<boolean> {
    const s = await this.waitSettled(afterAction ? 1500 : 0);
    return s.changed;
  }

  private async waitSettled(waitForChange: number): Promise<{ changed: boolean; waitMs: number }> {
    const t0 = Date.now(); let changes = 0;
    let prev = Buffer.from(this.fb.data as Buffer);
    let lastUpdate = Date.now(), lastChange = 0;
    const onUpdate = () => {
      const now = Buffer.from(this.fb.data as Buffer);
      const f = this.changedFraction(prev, now);
      if (f >= 0.0003) { changes++; lastChange = Date.now(); } // more than the ~230 px of the cursor
      prev = now; lastUpdate = Date.now();
      this.client.requestUpdate(true, 0, 0, this.width, this.height);
    };
    this.client.on("update", onUpdate);
    this.client.requestUpdate(true, 0, 0, this.width, this.height);
    try {
      while (true) {
        await sleep(40);
        const t = Date.now();
        if (waitForChange && changes === 0 && t - t0 < waitForChange) continue;
        if (t - Math.max(lastChange || t0, lastUpdate) >= this.opt.quietMs) break;
        if (t - t0 >= waitForChange + this.opt.settleMaxMs) break;
      }
    } finally { this.client.off("update", onUpdate); }
    return { changed: changes > 0, waitMs: Date.now() - t0 };
  }

  /**
   * Returns a PNG screenshot once the screen has settled.
   * afterAction=true: first waits for the app to repaint (it can take >1 s after a click), then waits for quiet.
   * If nothing repaints within waitForChangeMs, the action is assumed to have had no visible effect.
   */
  async screenshot(opts: { afterAction?: boolean; waitForChangeMs?: number } = {}): Promise<Screenshot> {
    const s = await this.waitSettled(opts.afterAction ? (opts.waitForChangeMs ?? 1500) : 0);
    const rgba = this.fb.toRgba();
    const png = await sharp(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength), { raw: { width: this.width, height: this.height, channels: 4 } }).png({ compressionLevel: 6 }).toBuffer();
    return { png, width: this.width, height: this.height, waitMs: s.waitMs, changed: s.changed };
  }

  private assertInside(x: number, y: number) {
    if (this.closed) throw new Error("desktop connection closed");
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= this.width || y >= this.height) throw new Error(`coordinate out of screen: ${x},${y} (screen is ${this.width}x${this.height})`);
  }

  async moveMouse(x: number, y: number) { this.assertInside(x, y); this.client.pointerEvent(x, y, 0); this.inputEvents++; }

  async click(x: number, y: number, opts: { button?: "left" | "right"; double?: boolean } = {}) {
    this.assertInside(x, y);
    const mask = opts.button === "right" ? buttons.right : buttons.left;
    const times = opts.double ? 2 : 1;
    this.client.pointerEvent(x, y, 0); await sleep(30);
    for (let i = 0; i < times; i++) {
      this.client.pointerEvent(x, y, mask); await sleep(this.opt.clickHoldMs);
      this.client.pointerEvent(x, y, 0); this.inputEvents++;
      if (times > 1 && i === 0) await sleep(80);
    }
  }

  async scroll(x: number, y: number, direction: "up" | "down", amount = 3) {
    this.assertInside(x, y);
    const mask = direction === "up" ? buttons.wheelUp : buttons.wheelDown;
    this.client.pointerEvent(x, y, 0);
    for (let i = 0; i < amount; i++) { this.client.pointerEvent(x, y, mask); await sleep(20); this.client.pointerEvent(x, y, 0); await sleep(40); this.inputEvents++; }
  }

  private keysymFor(name: string): number {
    const n = ALIASES[name.toLowerCase()] ?? name;
    if (KEYSYMS[n] !== undefined) return KEYSYMS[n];
    if ([...name].length === 1) return keysymFromChar(name);
    throw new Error(`unknown key: ${name}`);
  }

  /** Key combos such as "ctrl+a", "Return", "shift+Tab". Rejects combos that would close the kiosk. */
  async pressKey(combo: string, repeat = 1) {
    if (this.closed) throw new Error("desktop connection closed");
    const normalized = combo.toLowerCase().replace(/\s+/g, "");
    if (FORBIDDEN_KEYS.has(normalized)) throw new Error(`forbidden key combo (would close/reload the app): ${combo}`);
    const parts = combo.split("+").map((p) => p.trim()).filter(Boolean);
    const ks = parts.map((p) => this.keysymFor(p));
    for (let r = 0; r < repeat; r++) {
      for (const k of ks) { this.client.keyEvent(k, true); await sleep(this.opt.keyDelayMs); }
      for (const k of [...ks].reverse()) { this.client.keyEvent(k, false); await sleep(this.opt.keyDelayMs); }
      this.inputEvents++;
    }
  }

  /** Types text one keysym per character (accents, ñ and symbols included). */
  async typeText(text: string) {
    if (this.closed) throw new Error("desktop connection closed");
    for (const ch of text) {
      if (ch === "\n") { await this.pressKey("Return"); continue; }
      const k = keysymFromChar(ch);
      this.client.keyEvent(k, true); await sleep(this.opt.keyDelayMs);
      this.client.keyEvent(k, false); await sleep(this.opt.keyDelayMs);
      this.inputEvents++;
    }
  }

  /** Select all + delete + type (the server concatenates if you just type over existing text). */
  async replaceText(text: string) { await this.pressKey("ctrl+a"); await sleep(50); await this.pressKey("BackSpace"); await sleep(50); await this.typeText(text); }

  async close() {
    if (this.closed) return; this.closed = true;
    try { await this.client.close(); } catch {}
    try { this.ws.close(); } catch {}
  }
}
