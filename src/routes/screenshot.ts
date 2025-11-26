import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { captureAndUploadScreenshots } from "../services/screenshot-service.js";

const screenshotRequestSchema = z.object({
  tabId: z.number(),
  tabTitle: z.string(),
  type: z.enum(["production", "development"]),
  secret: z.string(),
});

export const screenshotRoute = new Hono();

screenshotRoute.post(
  "/capture",
  zValidator("json", screenshotRequestSchema),
  async (c) => {
    const { tabId, tabTitle, type, secret } = c.req.valid("json");

    console.log(
      `Received screenshot request for tabId: ${tabId}, tabTitle: ${tabTitle}, type: ${type}`
    );

    // Validate secret immediately
    if (secret !== process.env.SCREENSHOT_SECRET) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
      await captureAndUploadScreenshots(tabId, tabTitle, type);
      return c.json({ success: true });
    } catch (error) {
      console.error(`Screenshot capture failed for tab ${tabId}:`, error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500
      );
    }
  }
);
