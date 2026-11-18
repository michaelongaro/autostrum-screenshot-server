import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  captureTabScreenshotMasks,
  encodeTabScreenshotMaskAtlas,
  getTabScreenshotMaskKey,
  TAB_SCREENSHOT_MASK_HEIGHT,
  TAB_SCREENSHOT_MASK_WIDTH,
} from "./screenshot-masks.js";
import { readRenderedTabVersion } from "./rendered-tab-version.js";
import { createTabScreenshotThumbnails } from "./screenshot-thumbnails.js";

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let browserClosePromise: Promise<void> | null = null;

const activePlaywrightUses = new Set<symbol>();

let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

const idleCloseMs = Number(process.env.PLAYWRIGHT_IDLE_CLOSE_MS ?? 5_000);
const PLAYWRIGHT_IDLE_CLOSE_MS =
  Number.isInteger(idleCloseMs) && idleCloseMs >= 0 && idleCloseMs <= 2 ** 31 - 1
    ? idleCloseMs
    : 5_000;

const queueCapacity = Number(process.env.SCREENSHOT_QUEUE_CAPACITY ?? 4);
const SCREENSHOT_QUEUE_CAPACITY =
  Number.isSafeInteger(queueCapacity) && queueCapacity >= 0 ? queueCapacity : 4;

let acceptedCaptures = 0;
let captureTail = Promise.resolve();

function logMemory(stage: string, tabId?: number) {
  if (process.env.SCREENSHOT_MEMORY_LOGS !== "1") return;
  console.log(
    JSON.stringify({
      event: "screenshot-memory",
      stage,
      tabId,
      acceptedCaptures,
      ...process.memoryUsage(),
    }),
  );
}

function cancelIdleClose() {
  if (idleCloseTimer) {
    clearTimeout(idleCloseTimer);
    idleCloseTimer = null;
  }
}

function beginPlaywrightUse(tabId: number): symbol {
  const token = Symbol(`tab:${tabId}`);
  activePlaywrightUses.add(token);
  cancelIdleClose();
  return token;
}

function endPlaywrightUse(token: symbol) {
  activePlaywrightUses.delete(token);

  if (activePlaywrightUses.size === 0) {
    scheduleIdleClose();
  }
}

function scheduleIdleClose() {
  if (idleCloseTimer || activePlaywrightUses.size > 0) {
    return;
  }

  idleCloseTimer = setTimeout(() => {
    idleCloseTimer = null;
    void closeBrowserIfIdle();
  }, PLAYWRIGHT_IDLE_CLOSE_MS);

  idleCloseTimer.unref?.();
}

async function getBrowser(): Promise<Browser> {
  cancelIdleClose();

  if (browserClosePromise) {
    await browserClosePromise;
  }

  if (browserInstance && browserInstance.isConnected()) {
    return browserInstance;
  }

  if (!browserLaunchPromise) {
    console.log("Launching new Playwright browser instance...");

    browserLaunchPromise = chromium
      .launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox"],
      })
      .then((browser) => {
        browserInstance = browser;

        browser.on("disconnected", () => {
          if (browserInstance === browser) {
            browserInstance = null;
          }
        });

        return browser;
      })
      .finally(() => {
        browserLaunchPromise = null;
      });
  }

  return browserLaunchPromise;
}

async function closeBrowserIfIdle(): Promise<void> {
  if (activePlaywrightUses.size > 0) {
    return;
  }

  if (browserLaunchPromise) {
    await browserLaunchPromise.catch(() => undefined);
  }

  if (activePlaywrightUses.size > 0) {
    return;
  }

  if (browserClosePromise) {
    await browserClosePromise;
    return;
  }

  const browser = browserInstance;
  browserInstance = null;

  if (!browser) {
    return;
  }

  console.log("Closing idle Playwright browser instance...");

  const closePromise = browser
    .close()
    .then(() => logMemory("browser-idle-closed"))
    .catch((error) => {
      console.error("Failed to close Playwright browser:", error);
    });

  browserClosePromise = closePromise;

  await closePromise;

  if (browserClosePromise === closePromise) {
    browserClosePromise = null;
  }
}

export async function closeBrowser(): Promise<void> {
  cancelIdleClose();

  if (browserLaunchPromise) {
    await browserLaunchPromise.catch(() => undefined);
  }

  if (browserClosePromise) {
    await browserClosePromise;
    return;
  }

  const browser = browserInstance;
  browserInstance = null;

  if (!browser) {
    return;
  }

  console.log("Closing Playwright browser instance...");

  const closePromise = browser.close().catch((error) => {
    console.error("Failed to close Playwright browser:", error);
  });

  browserClosePromise = closePromise;

  await closePromise;

  if (browserClosePromise === closePromise) {
    browserClosePromise = null;
  }
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
  const token = beginPlaywrightUse(tabId);

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
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
    logMemory("masks-captured", tabId);
    if ((await readRenderedTabVersion(page, tabId)) !== version) {
      throw new Error(`Tab ${tabId} changed during screenshot capture`);
    }
    return { light, dark, rawMasks, version };
  } finally {
    if (context) {
      await context.close().catch((error) => {
        console.error(`Failed to close context for tab ${tabId}:`, error);
      });
    }

    endPlaywrightUse(token);
    logMemory("context-closed", tabId);
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

// Keep only one capture's Chromium, Sharp, and upload work in flight per replica.
// Admission includes the active capture plus the configured number of waiters.
export async function captureAndUploadScreenshots(
  tabId: number,
  tabTitle: string,
  type: "production" | "development",
): Promise<boolean> {
  if (acceptedCaptures > SCREENSHOT_QUEUE_CAPACITY) return false;

  acceptedCaptures++;
  const capture = captureTail.then(() => captureAndUpload(tabId, tabTitle, type));
  captureTail = capture.catch(() => undefined);
  try {
    await capture;
    return true;
  } finally {
    acceptedCaptures--;
    logMemory("capture-finished", tabId);
  }
}
