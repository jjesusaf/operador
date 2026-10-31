import { CanActivate, ExecutionContext, Injectable, UnauthorizedException } from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";
import type { Request } from "express";
import { ConfigService } from "../config.service.js";

/** Every call to the task endpoints must carry `Authorization: Bearer <team token>`. */
@Injectable()
export class BearerGuard implements CanActivate {
  constructor(private readonly config: ConfigService) {}

  canActivate(ctx: ExecutionContext): boolean {
    const req = ctx.switchToHttp().getRequest<Request>();
    const header = req.headers.authorization ?? "";
    const token = header.startsWith("Bearer ") ? header.slice(7).trim() : "";
    const expected = this.config.teamToken;
    const ok = token.length === expected.length && timingSafeEqual(Buffer.from(token), Buffer.from(expected));
    if (!ok) throw new UnauthorizedException("invalid or missing bearer token");
    return true;
  }
}
