import { BadRequestException, Body, Controller, Get, Headers, NotFoundException, Param, Post, UseGuards } from "@nestjs/common";
import type { TaskRequest, TaskStatusResponse } from "@operador/shared";
import { BearerGuard } from "../auth/bearer.guard.js";
import { TasksService } from "./tasks.service.js";

@Controller("tasks")
@UseGuards(BearerGuard)
export class TasksController {
  constructor(private readonly tasks: TasksService) {}

  /** POST /tasks → {"task_id": "..."} in < 2 s. */
  @Post()
  create(@Body() body: unknown, @Headers("x-received-at") receivedAtHeader?: string): { task_id: string } {
    // When a front door (the Worker) received the task earlier, the deadline counts from that moment.
    const receivedAt = Number(receivedAtHeader);
    const valid = Number.isFinite(receivedAt) && receivedAt > 0 && receivedAt <= Date.now() && Date.now() - receivedAt < 600_000;
    return this.tasks.submit(validate(body), valid ? receivedAt : undefined);
  }

  /** GET /tasks/:id → {"estado": "...", "resumen": "..."} */
  @Get(":id")
  status(@Param("id") id: string): TaskStatusResponse {
    const s = this.tasks.status(id);
    if (!s) throw new NotFoundException(`unknown task ${id}`);
    return s;
  }
}

function validate(body: unknown): TaskRequest {
  const b = body as any;
  const tarea = typeof b?.tarea === "string" ? b.tarea.trim() : "";
  const url = typeof b?.escritorio?.url === "string" ? b.escritorio.url.trim() : "";
  const password = typeof b?.escritorio?.password === "string" ? b.escritorio.password : "";
  if (!tarea) throw new BadRequestException("tarea is required");
  if (!/^wss?:\/\//.test(url)) throw new BadRequestException("escritorio.url must be a ws(s):// URL");
  if (!password) throw new BadRequestException("escritorio.password is required");
  return { tarea, escritorio: { url, password } };
}
