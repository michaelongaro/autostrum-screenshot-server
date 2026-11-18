import "dotenv/config";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { closeCaptureBrowser, screenshotRoute } from "./routes/screenshot.js";

const app = new Hono();

app.use("*", logger());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/screenshot", screenshotRoute);

const port = Number(process.env.PORT) || 3001;

console.log(`Screenshot server running on port ${port}`);
if (process.env.SCREENSHOT_MEMORY_LOGS === "1") {
  console.log(
    JSON.stringify({
      event: "screenshot-memory",
      stage: "startup",
      ...process.memoryUsage(),
    }),
  );
}

const server = serve({
  fetch: app.fetch,
  port,
});

let shuttingDown = false;
const shutdown = async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down...");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeCaptureBrowser();
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
