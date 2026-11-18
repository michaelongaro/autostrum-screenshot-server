import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";

let captureService:
  | Promise<typeof import("../services/screenshot-service.js")>
  | undefined;

export async function closeCaptureBrowser() {
  const service = await captureService?.catch(() => undefined);
  await service?.closeBrowser();
}

const screenshotRequestSchema = z.object({
  tabId: z.number().int().positive(),
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

    // Validate secret immediately
    if (secret !== process.env.SCREENSHOT_SECRET) {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    try {
      captureService ??= import("../services/screenshot-service.js");
      const service = await captureService;
      if (!(await service.captureAndUploadScreenshots(tabId, tabTitle, type))) {
        return c.json(
          { success: false, error: "Screenshot queue is full" },
          503,
          { "Retry-After": "5" },
        );
      }
      return c.json({ success: true });
    } catch (error) {
      console.error(`Screenshot capture failed for tab ${tabId}:`, error);
      return c.json(
        {
          success: false,
          error: error instanceof Error ? error.message : "Unknown error",
        },
        500,
      );
    }
  },
);
