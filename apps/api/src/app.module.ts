import { Module } from "@nestjs/common";
import { HealthController } from "./health/health.controller.js";
import { TasksController } from "./tasks/tasks.controller.js";
import { TasksService } from "./tasks/tasks.service.js";
import { TasksRepository } from "./tasks/tasks.repository.js";
import { BearerGuard } from "./auth/bearer.guard.js";
import { ConfigService } from "./config.service.js";

@Module({
  controllers: [HealthController, TasksController],
  providers: [ConfigService, TasksRepository, TasksService, BearerGuard],
})
export class AppModule {}
