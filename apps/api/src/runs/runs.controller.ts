import { Controller, Get, NotFoundException, Param, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { BearerGuard } from "../auth/bearer.guard.js";
import { ConfigService } from "../config.service.js";

/** Read-only access to a task's run artifacts (step log + screenshots) for debugging official runs. */
@Controller("internal/runs")
@UseGuards(BearerGuard)
export class RunsController {
  constructor(private readonly config: ConfigService) {}

  private dir(id: string): string {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new NotFoundException("bad id");
    const dir = join(this.config.dataDir, "runs", id);
    if (!existsSync(dir)) throw new NotFoundException("no run artifacts for this task");
    return dir;
  }

  @Get()
  list() {
    const root = join(this.config.dataDir, "runs");
    if (!existsSync(root)) return [];
    return readdirSync(root).map((id) => ({ id, files: readdirSync(join(root, id)).length }));
  }

  @Get(":id/log")
  log(@Param("id") id: string, @Res() res: Response) {
    const file = join(this.dir(id), "log.jsonl");
    if (!existsSync(file)) throw new NotFoundException("no log yet");
    res.type("application/x-ndjson").send(readFileSync(file));
  }

  @Get(":id/steps")
  steps(@Param("id") id: string) {
    return readdirSync(this.dir(id)).filter((f) => f.endsWith(".png")).sort();
  }

  @Get(":id/step/:file")
  step(@Param("id") id: string, @Param("file") file: string, @Res() res: Response) {
    if (!/^step-\d{2,3}\.png$/.test(file)) throw new NotFoundException("bad file");
    const path = join(this.dir(id), file);
    if (!existsSync(path)) throw new NotFoundException("no such step");
    res.type("image/png").send(readFileSync(path));
  }
}
