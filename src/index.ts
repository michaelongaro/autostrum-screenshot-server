import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { screenshotRoute } from "./routes/screenshot.js";
import { logServerMemory } from "./services/server-memory.js";

const app = new Hono();

app.use("*", logger());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/screenshot", screenshotRoute);

const port = Number(process.env.PORT) || 3001;

console.log(`Screenshot server running on port ${port}`);
logServerMemory("startup");

const server = serve({
  fetch: app.fetch,
  port,
});

let shuttingDown = false;
const shutdown = () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down...");
  server.close();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
