// Contract types shared by the API, the operator and the harness.

/** Body of POST /tasks (defined by the challenge). */
export interface TaskRequest {
  tarea: string;
  escritorio: { url: string; password: string };
}

/** Task states as the evaluator expects them (Spanish, by contract). */
export type TaskState = "en_curso" | "terminada" | "fallida";

/** Body of GET /tasks/{task_id}. */
export interface TaskStatusResponse {
  estado: TaskState;
  resumen: string;
}

/** Internal record of a task. */
export interface TaskRecord extends TaskStatusResponse {
  id: string;
  tarea: string;
  desktopUrl: string;
  createdAt: number;
  updatedAt: number;
  steps: number;
  costUsd: number;
  reason?: string;
}
