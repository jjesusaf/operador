import { Controller, Get } from "@nestjs/common";
import { ConfigService } from "../config.service.js";
import { TasksService } from "../tasks/tasks.service.js";

/** GET /health: 200 when the service is ready. No auth, so the platform validator can always reach it. */
@Controller("health")
export class HealthController {
  constructor(private readonly config: ConfigService, private readonly tasks: TasksService) {}

  @Get()
  health() {
    return {
      status: "ok",
      team: this.config.teamName,
      version: this.config.version,
      models: [this.config.model],
      notebook: this.config.notesUrl ? "d1" : "memory",
      tasks: this.tasks.stats(),
    };
  }
}
