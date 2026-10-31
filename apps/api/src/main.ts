import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { Logger } from "@nestjs/common";
import { AppModule } from "./app.module.js";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { logger: ["log", "warn", "error"] });
  app.enableShutdownHooks();
  const port = Number(process.env.PORT ?? 8080);
  await app.listen(port, "0.0.0.0");
  Logger.log(`listening on :${port}`, "bootstrap");
}
bootstrap();
