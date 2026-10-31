import { Injectable } from "@nestjs/common";

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required env var ${name}`);
  return v;
}

@Injectable()
export class ConfigService {
  readonly teamToken = required("TEAM_TOKEN");
  readonly openRouterApiKey = required("OPENROUTER_API_KEY");
  /** Optional second key (our own credits) selected per task with `X-Key-Profile: dev`; the evaluator never sends it. */
  readonly openRouterApiKeyDev = process.env.OPENROUTER_API_KEY_DEV ?? "";
  readonly model = process.env.OPENROUTER_MODEL ?? "anthropic/claude-sonnet-5.5";
  /** Cheaper/faster model for simple single-step tasks and notebook upkeep; empty → always use `model`. */
  readonly fastModel = process.env.OPENROUTER_MODEL_FAST ?? "anthropic/claude-haiku-5.5";
  readonly dataDir = process.env.DATA_DIR ?? "data";
  readonly teamName = process.env.TEAM_NAME ?? "operador";
  readonly version = process.env.APP_VERSION ?? "0.1.0";
  /** Hard deadline per task, measured from the moment POST /tasks is received. */
  readonly taskDeadlineMs = Number(process.env.TASK_DEADLINE_MS ?? 270_000);
  readonly maxConcurrentTasks = Number(process.env.MAX_CONCURRENT_TASKS ?? 2);
  readonly maxCostPerTaskUsd = Number(process.env.MAX_COST_PER_TASK_USD ?? 2.5);
  /** Base URL of the Worker that stores the per-app notebook (D1). Empty → in-memory notes. */
  readonly notesUrl = process.env.NOTES_URL ?? "";
}
