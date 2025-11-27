import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { logger } from "hono/logger";
import { screenshotRoute } from "./routes/screenshot.js";

const app = new Hono();

app.use("*", logger());

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/screenshot", screenshotRoute);

const port = Number(process.env.PORT) || 3001;

console.log(`Screenshot server running on port ${port}`);

serve({
  fetch: app.fetch,
  port,
});
