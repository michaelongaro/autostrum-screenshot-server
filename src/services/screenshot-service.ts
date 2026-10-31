import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "playwright";
import {
  captureTabScreenshotMasks,
  getTabScreenshotMaskKey,
} from "./screenshot-masks.js";
import { readRenderedTabVersion } from "./rendered-tab-version.js";

let browserInstance: Browser | null = null;
let browserLaunchPromise: Promise<Browser> | null = null;
let browserClosePromise: Promise<void> | null = null;

const activePlaywrightUses = new Set<symbol>();

let idleCloseTimer: ReturnType<typeof setTimeout> | null = null;

const PLAYWRIGHT_IDLE_CLOSE_MS = Number(
  process.env.PLAYWRIGHT_IDLE_CLOSE_MS ?? 60_000,
);

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

  const closePromise = browser.close().catch((error) => {
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
): Promise<{ light: Buffer; dark: Buffer; masks: Buffer; version: string }> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const token = beginPlaywrightUse(tabId);

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    const url = new URL(
      `/tab/${tabId}/${encodeURIComponent(tabTitle)}`,
      baseUrl,
    );
    url.searchParams.set("screenshot", "true");
    // Related grid cards should not load their own mask atlases during capture.
    url.searchParams.set("screenshotRenderer", "gradient-map");
    await page.goto(url.href, { waitUntil: "networkidle", timeout: 120_000 });

    // Wait for the screenshot elements to be visible
    await page
      .locator("#tabPreviewScreenshotLight")
      .waitFor({ state: "visible" });
    const version = await readRenderedTabVersion(page, tabId);
    await page.evaluate(() => document.fonts.ready);
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
    const light = await page.locator("#tabPreviewScreenshotLight").screenshot({
      type: "png",
      animations: "disabled",
    });
    const dark = await page.locator("#tabPreviewScreenshotDark").screenshot({
      type: "png",
      animations: "disabled",
    });
    const masks = await captureTabScreenshotMasks(page);
    return { light, dark, masks, version };
  } finally {
    if (context) {
      await context.close().catch((error) => {
        console.error(`Failed to close context for tab ${tabId}:`, error);
      });
    }

    endPlaywrightUse(token);
  }
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

  const { light, dark, masks, version } =
    await captureScreenshotsWithPlaywright(tabId, tabTitle);

  const [resizedLight, resizedDark] = await Promise.all([
    resizeImage(light),
    resizeImage(dark),
  ]);

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
      }),
    ),
    s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: `${tabId}/dark.jpeg`,
        Body: resizedDark,
        ContentType: "image/jpeg",
      }),
    ),
  ]);

  // Finish every in-flight upload before releasing the per-tab queue, including
  // on failure. Otherwise an older upload could complete during the next job.
  if (uploads.some((upload) => upload.status === "rejected")) {
    throw new Error(`Failed to upload all screenshot assets for tab ${tabId}`);
  }

  console.log(`Masks and fallback screenshots uploaded for tab ${tabId}`);
}

// Serialize captures of the same tab so an older in-flight save cannot finish
// uploading after a newer capture in this server process. Other tabs can still
// share the browser concurrently, each in its own context.
const pendingCaptures = new Map<string, Promise<void>>();

export async function captureAndUploadScreenshots(
  tabId: number,
  tabTitle: string,
  type: "production" | "development",
): Promise<void> {
  const key = `${type}:${tabId}`;
  const previous = pendingCaptures.get(key) ?? Promise.resolve();
  const capture = previous
    .catch(() => undefined)
    .then(() => captureAndUpload(tabId, tabTitle, type));
  pendingCaptures.set(key, capture);
  try {
    await capture;
  } finally {
    if (pendingCaptures.get(key) === capture) pendingCaptures.delete(key);
  }
}
