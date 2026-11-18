import { execFile, fork } from "node:child_process";
import { extname } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { logServerMemory } from "./server-memory.js";
import type { ScreenshotJob, ScreenshotWorkerFailure } from "./screenshot-worker.js";

const workerPath = fileURLToPath(
  new URL(`./screenshot-worker${extname(import.meta.url)}`, import.meta.url),
);
const execFileAsync = promisify(execFile);

const queueCapacity = Number(process.env.SCREENSHOT_QUEUE_CAPACITY ?? 4);
const SCREENSHOT_QUEUE_CAPACITY =
  Number.isSafeInteger(queueCapacity) && queueCapacity >= 0 ? queueCapacity : 4;

let acceptedCaptures = 0;
let captureTail = Promise.resolve();

function runWorker(job: ScreenshotJob): Promise<void> {
  return new Promise((resolve, reject) => {
    const worker = fork(workerPath);
    let failure: Error | undefined;
    worker.once("message", ({ message, stack }: ScreenshotWorkerFailure) => {
      failure = new Error(message);
      if (stack) failure.stack = stack;
    });
    worker.on("error", (error) => {
      failure ??= error;
    });
    // Release the slot only after the worker and its IPC channel have closed.
    worker.once("close", (code, signal) => {
      if (failure) reject(failure);
      else if (code === 0) resolve();
      else reject(new Error(`Screenshot worker exited (${signal ?? code})`));
    });
    worker.send(job);
  });
}

async function trimFileCache() {
  const { SCREENSHOT_CACHE_TRIMMER, PLAYWRIGHT_BROWSERS_PATH } = process.env;
  if (!SCREENSHOT_CACHE_TRIMMER || !PLAYWRIGHT_BROWSERS_PATH) return;

  try {
    await execFileAsync(
      SCREENSHOT_CACHE_TRIMMER,
      [
        PLAYWRIGHT_BROWSERS_PATH,
        fileURLToPath(new URL("../../node_modules/@img", import.meta.url)),
        fileURLToPath(new URL("../../node_modules/playwright-core", import.meta.url)),
      ],
      { timeout: 5_000 },
    );
  } catch (error) {
    console.warn("Could not release screenshot file cache:", error);
  }
}

export async function captureAndUploadScreenshots(
  job: ScreenshotJob,
): Promise<boolean> {
  if (acceptedCaptures > SCREENSHOT_QUEUE_CAPACITY) return false;

  acceptedCaptures++;
  const capture = captureTail
    .then(() => runWorker(job))
    .finally(async () => {
      // Keep files warm between queued captures and finish eviction before
      // starting another worker.
      if (--acceptedCaptures === 0) {
        await trimFileCache();
        logServerMemory("queue-drained", job.tabId);
      }
    });
  captureTail = capture.catch(() => undefined);
  await capture;
  return true;
}
