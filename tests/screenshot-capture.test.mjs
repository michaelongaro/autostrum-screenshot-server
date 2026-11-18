import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { buffer } from "node:stream/consumers";
import { test } from "node:test";
import { Hono } from "hono";
import sharp from "sharp";

const secret = "test-only-screenshot-secret";
const version = "2026-10-31T12:34:56.789Z";
const uploads = [];
let failNextUpload = false;
let pendingUploads = 0;
let pauseUploads;
// The capture worker runs in its own process, so stub S3 over HTTP.
const s3 = createServer(async (req, res) => {
  pendingUploads++;
  const fail = failNextUpload;
  failNextUpload = false;
  try {
    const [, bucket, ...key] = new URL(req.url, "http://localhost").pathname.split("/");
    uploads.push({
      Bucket: bucket,
      Key: key.join("/"),
      Body: await buffer(req),
      ContentType: req.headers["content-type"],
      Metadata: { "tab-version": req.headers["x-amz-meta-tab-version"] },
    });
    // Exercise queue behavior when one upload rejects before the others finish.
    if (fail) {
      res.writeHead(400, { "Content-Type": "application/xml" });
      res.end("<Error><Code>InvalidRequest</Code><Message>Test failure</Message></Error>");
      return;
    }
    await pauseUploads?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    res.end();
  } finally {
    pendingUploads--;
  }
});

process.env.SCREENSHOT_SECRET = secret;
process.env.AWS_ACCESS_KEY_ID = "test-only-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-only-secret-key";
process.env.SCREENSHOT_QUEUE_CAPACITY = "1";

const fixture = {
  version,
  tabId: 42,
  unmapped: false,
  legacy: false,
  missingRevision: false,
  visits: [],
};

function renderFixture() {
  const pageData = {
    json: { tab: { id: fixture.tabId, updatedAt: fixture.version } },
    meta: { values: { "tab.updatedAt": ["Date"] } },
  };
  const nextData = {
    props: { pageProps: { json: JSON.stringify(pageData) } },
  };
  const preview = (theme) => `
    <div id="tabPreviewScreenshot${theme}" class="preview" ${fixture.legacy || fixture.missingRevision ? "" : `data-tab-id="${fixture.tabId}" data-tab-version="${fixture.version}"`} data-color="maple" data-theme="${theme.toLowerCase()}">
      <div data-color="maple" data-theme="${theme.toLowerCase()}">
        <div class="accent">Section title</div>
        <div class="panel"><span class="notes">1 2 3 4</span><div class="staff"></div><span class="muted">Repeat</span></div>
        ${fixture.unmapped ? '<span style="color: red">Unmapped color</span>' : ""}
      </div>
    </div>`;
  return `<!doctype html><html><head><style>
    body { margin: 0; font-family: Arial; }
    [data-color][data-theme] {
      --screenshot-background: 15 67% 98%; --screenshot-foreground: 12 22% 32%;
      --screenshot-primary-foreground: 0 20% 99%; --screenshot-border: 16 25% 68%;
      --screenshot-accent: 15 20% 41%; --screenshot-secondary: 18 29% 87%; --gray: 20 5% 45%;
    }
    .preview { position: relative; width: 1318px; height: 615px; overflow: hidden; filter: grayscale(1);
      background: hsl(var(--screenshot-background)); color: hsl(var(--screenshot-foreground)); }
    .accent { position: absolute; left: 50px; top: 50px; width: 200px; height: 80px;
      background: hsl(var(--screenshot-accent)); color: hsl(var(--screenshot-primary-foreground)); }
    .panel { position: absolute; left: 50px; top: 180px; width: 1000px; height: 300px;
      border: 1px solid hsl(var(--screenshot-border)); background: hsl(var(--screenshot-secondary) / 0.25); }
    .notes { color: hsl(var(--screenshot-foreground)); }
    .staff { height: 1px; margin-top: 30px; background: hsl(var(--screenshot-foreground) / 0.5); }
    .muted { color: hsl(var(--gray)); }
  </style></head><body>${preview("Light")}${preview("Dark")}
    ${fixture.legacy ? `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>` : ""}
  </body></html>`;
}

test("capture API generates compatible masks without changing the request contract", async (t) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url, "http://localhost");
    fixture.visits.push({
      url,
      uploads: uploads.length,
      pendingUploads,
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    const html = renderFixture();
    res.end(url.pathname === "/screenshot-preview/42"
      ? html.replace("</body>", `<script>
          setTimeout(() => document.body.setAttribute("data-screenshot-ready", ""), 100);
        </script></body>`)
      : html);
  });
  server.listen(0, "127.0.0.1");
  s3.listen(0, "127.0.0.1");
  await Promise.all([once(server, "listening"), once(s3, "listening")]);
  process.env.BASE_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.AWS_ENDPOINT_URL_S3 = `http://127.0.0.1:${s3.address().port}`;

  const { screenshotRoute } = await import("../dist/routes/screenshot.js");
  const app = new Hono().route("/screenshot", screenshotRoute);
  t.after(async () => {
    await Promise.all(
      [server, s3].map((server) => new Promise((resolve) => server.close(resolve))),
    );
  });

  const capture = (overrides = {}) =>
    app.request("/screenshot/capture", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tabId: 42,
        tabTitle: "Test / title",
        type: "development",
        secret,
        ...overrides,
      }),
    });

  await t.test(
    "rejects unauthorized and invalid requests before capture",
    async () => {
      assert.equal((await capture({ secret: "incorrect" })).status, 401);
      assert.equal((await capture({ tabId: 1.5 })).status, 400);
      assert.equal((await capture({ tabId: -1 })).status, 400);
      assert.equal(fixture.visits.length, 0);
      assert.equal(uploads.length, 0);
    },
  );

  await t.test(
    "App Router page without __NEXT_DATA__ uploads originals and both thumbnail sizes",
    async () => {
      const response = await capture();
      assert.equal(response.status, 200, await response.text());
      assert.equal(uploads.length, 9);
      if (process.platform === "linux") {
        assert.equal(readFileSync("/proc/thread-self/children", "utf8").trim(), "");
      }
      const mask = uploads.find((upload) => upload.Key === "42/masks-v1.png");
      assert.equal(mask.Bucket, "autostrum-screenshots-dev");
      assert.equal(mask.ContentType, "image/png");
      assert.equal(mask.Metadata["tab-version"], version);
      const metadata = await sharp(mask.Body).metadata();
      assert.equal(metadata.width, 1200);
      assert.equal(metadata.height, 560 * 7);
      assert.equal(metadata.channels, 4);

      const { data, info } = await sharp(mask.Body)
        .raw()
        .toBuffer({ resolveWithObject: true });
      const alpha = (role, x, y) =>
        data[((role * 560 + y) * info.width + x) * 4 + 3];
      assert.equal(alpha(0, 8, 8), 255);
      assert.equal(alpha(1, 8, 8), 0);
      assert(
        Math.abs(alpha(0, 546, 364) - 191) <= 1,
        "Panel preserves background contribution",
      );
      assert(
        Math.abs(alpha(5, 546, 364) - 64) <= 1,
        "Panel preserves secondary opacity",
      );
      for (const theme of ["light", "dark"]) {
        const image = uploads.find(
          (upload) => upload.Key === `42/${theme}.jpeg`,
        );
        assert.equal(image.ContentType, "image/jpeg");
        assert.equal((await sharp(image.Body).metadata()).width, 1200);
      }
      for (const width of [400, 800]) {
        const height = Math.round((width * 560) / 1200);
        for (const filename of ["light.jpeg", "dark.jpeg", "masks-v1.png"]) {
          const thumbnail = uploads.find(
            (upload) => upload.Key === `42/card-v1/${width}/${filename}`,
          );
          assert.equal(thumbnail.Bucket, "autostrum-screenshots-dev");
          assert.equal(thumbnail.Metadata["tab-version"], version);
          const metadata = await sharp(thumbnail.Body).metadata();
          assert.equal(metadata.width, width);
          assert.equal(
            metadata.height,
            filename.endsWith("png") ? height * 7 : height,
          );
          assert.equal(
            thumbnail.ContentType,
            filename.endsWith("png") ? "image/png" : "image/jpeg",
          );
        }
      }
      assert.equal(
        fixture.visits[0].url.searchParams.get("screenshotRenderer"),
        "gradient-map",
      );
    },
  );

  await t.test("supports legacy Pages Router during rollout", async () => {
    fixture.legacy = true;
    const start = uploads.length;
    try {
      assert.equal((await capture()).status, 200);
      assert.equal(uploads.length - start, 9);
      assert.equal(uploads[start].Metadata["tab-version"], version);
    } finally {
      fixture.legacy = false;
    }
  });

  await t.test("captures from the configured screenshot-only route", async () => {
    process.env.SCREENSHOT_USE_PREVIEW_ROUTE = "1";
    const start = uploads.length;
    try {
      const response = await capture();
      assert.equal(response.status, 200, await response.text());
      assert.equal(fixture.visits.at(-1).url.pathname, "/screenshot-preview/42");
      assert.equal(uploads.length - start, 9);
      assert.equal(uploads[start].Metadata["tab-version"], version);
    } finally {
      delete process.env.SCREENSHOT_USE_PREVIEW_ROUTE;
    }
  });

  await t.test("rejects missing App Router revision without uploading", async () => {
    fixture.missingRevision = true;
    const start = uploads.length;
    try {
      assert.equal((await capture()).status, 500);
      assert.equal(uploads.length, start);
    } finally {
      fixture.missingRevision = false;
    }
  });

  await t.test(
    "uses production bucket and the revision actually rendered",
    async () => {
      fixture.version = "2026-11-01T09:00:00.123Z";
      const start = uploads.length;
      assert.equal((await capture({ type: "production" })).status, 200);
      assert(
        uploads
          .slice(start)
          .every((upload) => upload.Bucket === "autostrum-screenshots"),
      );
      assert.equal(uploads[start].Metadata["tab-version"], fixture.version);
      fixture.version = version;
    },
  );

  await t.test(
    "serializes the same tab through the end of its uploads",
    async () => {
      const start = uploads.length;
      const visits = fixture.visits.length;
      const responses = await Promise.all([capture(), capture()]);
      assert(responses.every((response) => response.status === 200));
      const arrivals = fixture.visits.slice(visits);
      assert.deepEqual(
        arrivals.map((visit) => visit.uploads - start),
        [0, 9],
      );
      assert(arrivals.every((visit) => visit.pendingUploads === 0));
    },
  );

  await t.test(
    "does not upload unverified revisions or unmapped colors",
    async () => {
      const start = uploads.length;
      fixture.version = "invalid";
      assert.equal((await capture()).status, 500);
      fixture.version = version;
      fixture.tabId = 99;
      assert.equal((await capture()).status, 500);
      fixture.tabId = 42;
      fixture.unmapped = true;
      assert.equal((await capture()).status, 500);
      fixture.unmapped = false;
      assert.equal(uploads.length, start);
    },
  );

  await t.test(
    "waits for remaining uploads after failure and recovers the queue",
    async () => {
      failNextUpload = true;
      const visits = fixture.visits.length;
      const responses = await Promise.all([capture(), capture()]);
      assert.deepEqual(
        responses.map((response) => response.status),
        [500, 200],
      );
      assert(
        fixture.visits
          .slice(visits)
          .every((visit) => visit.pendingUploads === 0),
      );
    },
  );

  await t.test("queues other buckets and returns a retryable response when full", { timeout: 30_000 }, async () => {
    let notifyEntered;
    let releaseUploads;
    const entered = new Promise((resolve) => { notifyEntered = resolve; });
    const resume = new Promise((resolve) => { releaseUploads = resolve; });
    pauseUploads = () => {
      notifyEntered();
      return resume;
    };

    const visits = fixture.visits.length;
    const active = capture();
    let queued;
    try {
      await entered;
      queued = capture({ type: "production" });
      const overflow = await capture();
      assert.equal(overflow.status, 503);
      assert.equal(overflow.headers.get("Retry-After"), "5");
      assert.equal(fixture.visits.length - visits, 1);
    } finally {
      pauseUploads = undefined;
      releaseUploads();
      const responses = await Promise.all([active, queued]);
      assert.deepEqual(responses.map((response) => response?.status), [200, 200]);
    }
    assert.equal(fixture.visits.length - visits, 2);
    assert.equal(fixture.visits.at(-1).pendingUploads, 0);
  });
});
