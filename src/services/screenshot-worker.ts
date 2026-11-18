import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { chromium, type Browser } from "playwright";
import {
  captureTabScreenshotMasks,
  encodeTabScreenshotMaskAtlas,
  getTabScreenshotMaskKey,
  TAB_SCREENSHOT_MASK_HEIGHT,
  TAB_SCREENSHOT_MASK_WIDTH,
} from "./screenshot-masks.js";
import { readRenderedTabVersion } from "./rendered-tab-version.js";
import { createTabScreenshotThumbnails } from "./screenshot-thumbnails.js";

export interface ScreenshotJob {
  tabId: number;
  tabTitle: string;
  type: "production" | "development";
}

export interface ScreenshotWorkerFailure {
  message: string;
  stack?: string;
}

function logMemory(stage: string, tabId: number) {
  if (process.env.SCREENSHOT_MEMORY_LOGS !== "1") return;
  console.log(
    JSON.stringify({
      event: "screenshot-memory",
      stage,
      tabId,
      ...process.memoryUsage(),
    }),
  );
}

const s3 = new S3Client({
  region: "us-east-2",
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID!,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY!,
  },
});

async function resizeImage(buffer: Buffer): Promise<Buffer> {
  return sharp(buffer)
    .resize({ width: 1200 }) // 1318px is the original width of the screenshot
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function captureScreenshotsWithPlaywright(
  tabId: number,
  tabTitle: string,
): Promise<{ light: Buffer; dark: Buffer; rawMasks: Buffer; version: string }> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  let browser: Browser | undefined;

  try {
    browser = await chromium.launch({ headless: true });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();
    page.setDefaultTimeout(30_000);

    if (process.env.SCREENSHOT_USE_PREVIEW_ROUTE === "1") {
      const url = new URL(`/screenshot-preview/${tabId}`, baseUrl);
      const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
      if (!response?.ok()) {
        throw new Error(`Screenshot preview request failed for tab ${tabId}`);
      }
      await page.locator("[data-screenshot-ready]").waitFor({ state: "attached" });
    } else {
      const url = new URL(`/tab/${tabId}/${encodeURIComponent(tabTitle)}`, baseUrl);
      url.searchParams.set("screenshot", "true");
      // Related grid cards should not load their own mask atlases during capture.
      url.searchParams.set("screenshotRenderer", "gradient-map");
      await page.goto(url.href, { waitUntil: "networkidle", timeout: 120_000 });
    }

    const lightPreview = page.locator("#tabPreviewScreenshotLight");
    const darkPreview = page.locator("#tabPreviewScreenshotDark");
    await Promise.all([
      lightPreview.waitFor({ state: "visible" }),
      darkPreview.waitFor({ state: "visible" }),
    ]);
    const version = await readRenderedTabVersion(page, tabId);
    await page.waitForFunction(() => document.fonts.status === "loaded");
    await page.addStyleTag({
      content: "nextjs-portal { display: none !important; }",
    });

    // Hide UI elements that shouldn't be in the screenshot
    await page.evaluate(() => {
      const header = document.getElementById("desktopHeader");
      if (header) header.style.display = "none";

      const controls = document.getElementById("stickyBottomControls");
      if (controls) controls.style.display = "none";
    });

    // Take screenshots sequentially: locator captures can scroll the same page.
    // Encode JPEG only once, after resizing the lossless source captures.
    const light = await lightPreview.screenshot({
      type: "png",
      animations: "disabled",
    });
    const dark = await darkPreview.screenshot({
      type: "png",
      animations: "disabled",
    });
    const rawMasks = await captureTabScreenshotMasks(page);
    if ((await readRenderedTabVersion(page, tabId)) !== version) {
      throw new Error(`Tab ${tabId} changed during screenshot capture`);
    }
    return { light, dark, rawMasks, version };
  } finally {
    await browser?.close();
    logMemory("browser-closed", tabId);
  }
}

async function buildScreenshotAssets(tabId: number, tabTitle: string) {
  const { light, dark, rawMasks, version } =
    await captureScreenshotsWithPlaywright(tabId, tabTitle);
  const masks = await encodeTabScreenshotMaskAtlas(
    rawMasks,
    TAB_SCREENSHOT_MASK_WIDTH,
    TAB_SCREENSHOT_MASK_HEIGHT,
  );
  const resizedLight = await resizeImage(light);
  const resizedDark = await resizeImage(dark);
  const thumbnails = await createTabScreenshotThumbnails(tabId, {
    light,
    dark,
    rawMasks,
  });
  return { masks, resizedLight, resizedDark, thumbnails, version };
}

async function captureAndUpload(
  tabId: number,
  tabTitle: string,
  type: "production" | "development",
): Promise<void> {
  const bucket =
    type === "production"
      ? "autostrum-screenshots"
      : "autostrum-screenshots-dev";

  logMemory("capture-started", tabId);
  const { masks, resizedLight, resizedDark, thumbnails, version } =
    await buildScreenshotAssets(tabId, tabTitle);
  logMemory("assets-encoded", tabId);

  const uploads = await Promise.allSettled([
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: getTabScreenshotMaskKey(tabId),
        Body: masks,
        ContentType: "image/png",
        Metadata: { "tab-version": version },
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${tabId}/light.jpeg`,
        Body: resizedLight,
        ContentType: "image/jpeg",
        Metadata: { "tab-version": version },
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${tabId}/dark.jpeg`,
        Body: resizedDark,
        ContentType: "image/jpeg",
        Metadata: { "tab-version": version },
      }),
    ),
    ...thumbnails.map(({ key, body, contentType }) =>
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType,
          Metadata: { "tab-version": version },
        }),
      ),
    ),
  ]);

  // Finish every in-flight upload before releasing the queue, including
  // on failure. Otherwise an older upload could complete during the next job.
  if (uploads.some((upload) => upload.status === "rejected")) {
    throw new Error(`Failed to upload all screenshot assets for tab ${tabId}`);
  }

  console.log(
    `Masks, fallback screenshots, and card thumbnails uploaded for tab ${tabId}`,
  );
}

process.once("message", async ({ tabId, tabTitle, type }: ScreenshotJob) => {
  try {
    await captureAndUpload(tabId, tabTitle, type);
  } catch (error) {
    process.exitCode = 1;
    process.send?.({
      message: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack : undefined,
    } satisfies ScreenshotWorkerFailure);
  } finally {
    s3.destroy();
    if (process.connected) process.disconnect?.();
  }
});
