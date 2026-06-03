import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { chromium, type Browser, type BrowserContext } from "playwright";

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
    .resize({ width: Math.round(1318 / 3.25) }) // 1318px is the original width of the screenshot
    .jpeg({ quality: 90 })
    .toBuffer();
}

async function captureScreenshotsWithPlaywright(
  tabId: number,
  tabTitle: string,
): Promise<[Buffer, Buffer]> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const token = beginPlaywrightUse(tabId);

  let context: BrowserContext | null = null;

  try {
    const browser = await getBrowser();

    context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    await page.goto(
      `${baseUrl}/tab/${tabId}/${encodeURIComponent(tabTitle)}?screenshot=true`,
    );

    // Wait for the screenshot elements to be visible
    await page
      .locator("#tabPreviewScreenshotLight")
      .waitFor({ state: "visible" });

    // Hide UI elements that shouldn't be in the screenshot
    await page.evaluate(() => {
      const header = document.getElementById("desktopHeader");
      if (header) header.style.display = "none";

      const controls = document.getElementById("stickyBottomControls");
      if (controls) controls.style.display = "none";
    });

    const screenshots = await Promise.all([
      page.locator("#tabPreviewScreenshotLight").screenshot({
        type: "jpeg",
        quality: 90,
      }),
      page.locator("#tabPreviewScreenshotDark").screenshot({
        type: "jpeg",
        quality: 90,
      }),
    ]);

    return screenshots;
  } finally {
    if (context) {
      await context.close().catch((error) => {
        console.error(`Failed to close context for tab ${tabId}:`, error);
      });
    }

    endPlaywrightUse(token);
  }
}

export async function captureAndUploadScreenshots(
  tabId: number,
  tabTitle: string,
  type: "production" | "development",
): Promise<void> {
  const bucket =
    type === "production"
      ? "autostrum-screenshots"
      : "autostrum-screenshots-dev";

  const [lightImageBuffer, darkImageBuffer] =
    await captureScreenshotsWithPlaywright(tabId, tabTitle);

  const [resizedLight, resizedDark] = await Promise.all([
    resizeImage(lightImageBuffer),
    resizeImage(darkImageBuffer),
  ]);

  await Promise.all([
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

  console.log(`Screenshots uploaded for tab ${tabId}`);
}
