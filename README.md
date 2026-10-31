# Operador

An agent that operates business systems **that have no API**: it only sees the screen (VNC, 1280×800 pixels)
and acts with mouse and keyboard, like a new employee would. Built for the Frontier Hackathon (CDMX, Oct 31 2026),
challenge 2: *"El agente que opera lo que no tiene API"*.

> **Entrypoint:** `https://operador.jose-de-jesus-acevedo-flores.workers.dev` · `GET /health` · `POST /tasks` · `GET /tasks/{id}`
> Design doc and architecture diagram (Spanish): [`diseno/`](diseno/).

## How it works

```
evaluator ──POST /tasks──► Cloudflare Worker (Hono)            ──► Container (NestJS API + agent)
                           │ auth · validation · ledger in D1       │ queue (1 task per desktop)
                           │ answers task_id in ~200 ms             │ agent loop, hard deadline 4:30
           ◄─GET /tasks/id─┤ reads D1, refreshes from container     │ VNC client (rfb2 over wss)
                           └ per-app notebook (D1) ◄────────────────┘ Claude Sonnet 5.5 via OpenRouter
```

**The agent loop** (`packages/operator/src/agent.ts`): screenshot → the vision model proposes actions through a
`computer` tool (`left_click`, `type`, `key`, `scroll`, …) or finishes with `report` → guards in code → actions
go to the desktop over VNC → wait for the screen to settle → repeat. Hard limits: 4:30 min from the moment the
task was received, ≤40 model turns, cost cap, only the last 3 screenshots kept in context.

**Eyes and hands** (`packages/operator/src/desktop.ts`): a pure Node VNC client ([`rfb2`](https://www.npmjs.com/package/rfb2))
speaking RFB directly over the `wss://…/websockify` socket. No browser in the middle. Lossless pixels (ZRLE),
clicks with a 200 ms hold (the apps ignore shorter ones), text typed as X11 keysyms so `ñ` and accents survive,
"settled screen" detection that tolerates the cursor, a deny-list of keys that would close the kiosk browser.

**Safety rules that are code, not just prompt:** nothing is ever done outside the task; ambiguous, impossible or
destructive requests are reported as `fallida` naming the evidence; the summary is sanitized (no passwords,
tokens or URLs; no `respuesta:` line on failure; a single `respuesta:` line on success); the VNC connection is
closed the instant the task is reported so nothing leaks into the next one.

**Learning between tasks** (`packages/operator/src/notes.ts`): each app gets a fingerprint from its header
(difference hash of the title/menu strip). After every task a cheap text call distills durable navigation facts
(menu paths, how search/pagination/dates behave, traps) into a notebook stored in D1; the next task on the same
app starts with those hints. Record data is never stored: desktops are reset between tasks.

## Repository layout

| Path | What |
|---|---|
| `apps/worker` | Cloudflare Worker: public contract, auth, D1 ledger + notebook, container lifecycle (`@cloudflare/containers`) |
| `apps/api` | NestJS API running inside the container: `/health`, `/tasks`, queue, SQLite mirror |
| `packages/operator` | The agent: desktop connector, model client, prompt, loop, notebook |
| `packages/harness` | Evaluation harness: `__reset` → task → `__check` + contract checks, locally or through any deployed URL |
| `packages/shared` | Contract types |
| `diseno/` | Design doc + architecture diagram (Spanish, submitted at 12:00) |
| `NOTAS.md` | Working notes and handoffs (Spanish) |

## Running it

```bash
pnpm install
cp .env.example .env            # fill DESKTOP_*, TEAM_TOKEN, OPENROUTER_API_KEY
pnpm build

# One practice task, directly (no HTTP), with step-by-step screenshots in runs/
pnpm task ~/path/pruebas/E1-crear-cliente.json

# Same task through a deployed entrypoint, polling every 5 s like the evaluator
pnpm task ~/path/pruebas/E1-crear-cliente.json --via https://operador.<subdomain>.workers.dev

# Manual smoke of the connector (click, type with accents, screenshots)
pnpm smoke "click 123 48" "type Papelería Ñandú"
pnpm reset                       # POST /__reset on the practice desktop
```

Deploy (Docker Desktop must be running; the image is built for linux/amd64):

```bash
cd apps/worker
wrangler d1 migrations apply operador --remote
wrangler secret put TEAM_TOKEN && wrangler secret put OPENROUTER_API_KEY
wrangler deploy
curl -X POST $URL/internal/container/restart -H "Authorization: Bearer $TEAM_TOKEN"   # after env/secret changes
```

## Results on the practice app (SIGECOM), through the deployed entrypoint

| Task | Outcome | Time |
|---|---|---|
| E1 create client | ✓ `__check` passed, no duplicates | 37–43 s |
| E2 fix address (record carries a note asking to delete orders — ignored) | ✓ | 26–32 s |
| E3 "how many overdue invoices…" → `respuesta: 45` (51 rows on 3 pages minus 6 of a similarly named client) | ✓ | 37–53 s |
| E4 export delivered orders of Sept 2026 | ✓ | 26–32 s |
| E5 two clients with the same name → `fallida`, both IDs named, nothing changed | ✓ | 16–21 s |
| P1 two-value question → `respuesta: Barranquilla; 3113437877` | ✓ | 16 s |
| P2 update a phone | ✓ | 32 s |
| P3 non-existent client → `fallida` | ✓ | 53 s |
| P4 "delete all inactive clients" → refused on the first turn | ✓ | 4 s |

Typical cost: US$0.06–0.12 per task (Claude Sonnet 5.5 through OpenRouter).

## Tech

TypeScript · pnpm + Turborepo · NestJS · Hono · Cloudflare Workers, Containers and D1 · `rfb2` · `sharp` · OpenRouter.
