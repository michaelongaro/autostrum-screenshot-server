import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import sharp from "sharp";
import { chromium, type Browser } from "playwright";

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

export async function captureAndUploadScreenshots(
  tabId: number,
  tabTitle: string,
  type: "production" | "development"
): Promise<void> {
  const baseUrl = process.env.BASE_URL ?? "http://localhost:3000";
  const bucket =
    type === "production"
      ? "autostrum-screenshots"
      : "autostrum-screenshots-dev";

  let browser: Browser | null = null;

  try {
    browser = await chromium.launch({
      headless: true,
      args: ["--no-sandbox", "--disable-setuid-sandbox"],
    });

    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
    });

    const page = await context.newPage();

    await page.goto(
      `${baseUrl}/tab/${tabId}/${encodeURIComponent(tabTitle)}?screenshot=true`
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

    // Capture both screenshots in parallel
    const [lightImageBuffer, darkImageBuffer] = await Promise.all([
      page.locator("#tabPreviewScreenshotLight").screenshot({
        type: "jpeg",
        quality: 90,
      }),
      page.locator("#tabPreviewScreenshotDark").screenshot({
        type: "jpeg",
        quality: 90,
      }),
    ]);

    // Resize both images
    const [resizedLight, resizedDark] = await Promise.all([
      resizeImage(lightImageBuffer),
      resizeImage(darkImageBuffer),
    ]);

    // Upload to S3
    await Promise.all([
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${tabId}/light.jpeg`,
          Body: resizedLight,
          ContentType: "image/jpeg",
        })
      ),
      s3.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: `${tabId}/dark.jpeg`,
          Body: resizedDark,
          ContentType: "image/jpeg",
        })
      ),
    ]);

    console.log(`Screenshots uploaded for tab ${tabId}`);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}
