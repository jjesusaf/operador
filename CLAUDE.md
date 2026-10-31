# Operador — Frontier Reto 2

Agent that operates GUI-only systems over VNC (no DOM, no API), driven by a vision model.

## Rules
- **All code in English**: file names, identifiers, comments, log messages, commit messages.
  Working notes for the team (`NOTAS.md`) stay in Spanish.
- Secrets live in `.env` only (git-ignored). Never log the desktop password or tokens.
- Never hardcode anything about the practice app (SIGECOM): evaluation runs on an unseen app.
- `pnpm exec tsc --noEmit` must pass before claiming anything works.
- Smoke/manual tools live in `spikes/`; production code in `src/`.
