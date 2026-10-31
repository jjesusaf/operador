// Run one practice task end to end against the practice desktop (direct, no HTTP):
//   __reset → agent → __check → contract checks (status, respuesta:, claves_razon, secrets).
//   pnpm task ~/Downloads/frontier-reto-2/pruebas/E1-crear-cliente.json
import { readFileSync } from "node:fs";
import { runTask } from "@operador/operator";

const file = process.argv[2];
if (!file) { console.error("usage: run-task.ts <test.json> [--no-reset]"); process.exit(1); }
const test = JSON.parse(readFileSync(file, "utf8"));
const env = (k: string) => { const v = process.env[k]; if (!v) throw new Error(`missing ${k} in .env`); return v; };
const http = env("DESKTOP_HTTP"), token = env("DESKTOP_TOKEN");

async function desktopApi(path: string, body?: unknown) {
  const r = await fetch(`${http}${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
}

if (!process.argv.includes("--no-reset")) { const r = await desktopApi("/__reset"); console.log(`__reset → ${r.status}`); }

console.log(`\n▶ ${test.id} (${test.nivel}): ${test.instruccion}\n`);
const viaIdx = process.argv.indexOf("--via");
const via = viaIdx > 0 ? process.argv[viaIdx + 1] : undefined; // e.g. --via http://localhost:8080 (goes through the API like the evaluator)

interface Outcome { status: "done" | "failed"; summary: string; steps: number; costUsd: number; elapsedMs: number; inputEvents: number; reason?: string; }
let result: Outcome;
if (via) {
  const t0 = Date.now();
  // --dev-key makes the deployed service bill our own OpenRouter key (X-Key-Profile: dev) instead of the event's.
  const headers: Record<string, string> = { Authorization: `Bearer ${env("TEAM_TOKEN")}`, "Content-Type": "application/json", ...(process.argv.includes("--dev-key") ? { "X-Key-Profile": "dev" } : {}) };
  const post = await fetch(`${via}/tasks`, { method: "POST", headers, body: JSON.stringify({ tarea: test.instruccion, escritorio: { url: env("DESKTOP_WSS"), password: env("DESKTOP_PASSWORD") } }) });
  const postMs = Date.now() - t0;
  const { task_id } = await post.json() as { task_id: string };
  console.log(`  POST /tasks → ${post.status} in ${postMs} ms · task_id ${task_id}${postMs > 2000 ? "  ✗ SLOWER THAN 2 s" : ""}`);
  let estado = "en_curso", resumen = "";
  while (estado === "en_curso" && Date.now() - t0 < 5 * 60_000) {
    await new Promise((r) => setTimeout(r, 5000));
    const r = await fetch(`${via}/tasks/${task_id}`, { headers });
    ({ estado, resumen } = await r.json() as { estado: string; resumen: string });
    console.log(`  poll ${((Date.now() - t0) / 1000).toFixed(0)}s → ${estado}`);
  }
  result = { status: estado === "terminada" ? "done" : "failed", summary: resumen, steps: -1, costUsd: 0, elapsedMs: Date.now() - t0, inputEvents: -1, reason: estado === "en_curso" ? "still_running_after_5min" : undefined };
} else {
  result = await runTask({
    task: test.instruccion,
    desktop: { url: env("DESKTOP_WSS"), password: env("DESKTOP_PASSWORD") },
    model: { apiKey: process.env.OPENROUTER_API_KEY_DEV || env("OPENROUTER_API_KEY"), model: env("OPENROUTER_MODEL") }, // local runs prefer our own key
    logDir: `runs/${test.id}-${new Date().toISOString().slice(11, 19).replace(/:/g, "")}`,
    secrets: [token, env("TEAM_TOKEN")],
    onStep: (s) => console.log(`  step ${s.step} · ${(s.elapsedMs / 1000).toFixed(1)}s · model ${s.modelMs} ms · $${s.cost.toFixed(4)} · ${s.calls.join(", ") || "(text)"}`),
  });
}

console.log(`\n■ status=${result.status} (${result.reason ?? "reported"}) · ${result.steps} steps · ${(result.elapsedMs / 1000).toFixed(1)}s · $${result.costUsd.toFixed(4)} · ${result.inputEvents} input events`);
console.log(`  summary: ${result.summary.replace(/\n/g, "\n           ")}`);

// Contract checks the app-side __check cannot see.
const checks: Array<[string, boolean]> = [];
checks.push([`estado == ${test.estado_esperado}`, result.status === (test.estado_esperado === "terminada" ? "done" : "failed")]);
const answerLine = result.summary.split("\n").find((l) => /^\s*respuesta\s*:/i.test(l));
if (test.respuesta_esperada !== undefined) {
  const expected = String(test.respuesta_esperada);
  const answer = answerLine?.replace(/^\s*respuesta\s*:/i, "").trim() ?? "";
  if (/^-?\d+([.,]\d+)?$/.test(expected)) {
    // Numeric answer: the evaluator compares the FIRST number on the line.
    const firstNumber = answer.match(/-?\d+([.,]\d+)?/)?.[0];
    checks.push([`respuesta: first number == ${expected} (got ${firstNumber ?? "none"})`, firstNumber === expected]);
  } else {
    // Text answer(s): compare each ';'-separated part, ignoring case and accents.
    const norm = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9;]+/g, " ").trim();
    const want = expected.split(";").map(norm), got = answer.split(";").map(norm);
    const ok = want.length === got.length && want.every((w, i) => got[i].includes(w) || w.includes(got[i]));
    checks.push([`respuesta == "${expected}" (got "${answer || "none"}")`, ok]);
  }
}
if (test.estado_esperado === "fallida") checks.push(["no 'respuesta:' line on failure", !answerLine]);
for (const key of test.claves_razon ?? []) checks.push([`summary names ${key}`, result.summary.includes(key)]);
checks.push(["summary has no password", !result.summary.includes(env("DESKTOP_PASSWORD"))]);

const check = await desktopApi("/__check", test);
console.log(`\n__check → ${check.status} pass=${check.body.pass}`);
for (const c of check.body.checks ?? []) console.log(`  ${c.ok ? "✓" : "✗"} ${c.nombre}`);
console.log("contract:");
for (const [name, ok] of checks) console.log(`  ${ok ? "✓" : "✗"} ${name}`);
const allOk = check.body.pass === true && checks.every(([, ok]) => ok);
console.log(`\n${allOk ? "PASS" : "FAIL"} ${test.id}`);
