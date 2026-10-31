import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mock, test } from "node:test";
import { S3Client } from "@aws-sdk/client-s3";
import { Hono } from "hono";
import sharp from "sharp";

const secret = "test-only-screenshot-secret";
const version = "2026-10-31T12:34:56.789Z";
const uploads = [];
let failNextUpload = false;
let pendingUploads = 0;
const send = mock.method(S3Client.prototype, "send", async (command) => {
  pendingUploads++;
  uploads.push(command.input);
  const fail = failNextUpload;
  failNextUpload = false;
  try {
    // Exercise queue behavior when one upload rejects before the others finish.
    if (fail) throw new Error("Test upload failure");
    await new Promise((resolve) => setTimeout(resolve, 10));
    return {};
  } finally {
    pendingUploads--;
  }
});

process.env.SCREENSHOT_SECRET = secret;
process.env.AWS_ACCESS_KEY_ID = "test-only-access-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-only-secret-key";

const fixture = {
  version,
  tabId: 42,
  unmapped: false,
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
    <div id="tabPreviewScreenshot${theme}" class="preview" data-color="maple" data-theme="${theme.toLowerCase()}">
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
    <script id="__NEXT_DATA__" type="application/json">${JSON.stringify(nextData)}</script>
  </body></html>`;
}

test("capture API generates compatible masks without changing the request contract", async (t) => {
  const server = createServer((req, res) => {
    fixture.visits.push({
      url: new URL(req.url, "http://localhost"),
      uploads: uploads.length,
      pendingUploads,
    });
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(renderFixture());
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  process.env.BASE_URL = `http://127.0.0.1:${server.address().port}`;

  const { screenshotRoute } = await import("../dist/routes/screenshot.js");
  const { closeBrowser } =
    await import("../dist/services/screenshot-service.js");
  const app = new Hono().route("/screenshot", screenshotRoute);
  t.after(async () => {
    await closeBrowser();
    await new Promise((resolve) => server.close(resolve));
    send.mock.restore();
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
    "legacy request uploads the mask atlas and both fallback JPEGs",
    async () => {
      const response = await capture();
      assert.equal(response.status, 200, await response.text());
      assert.equal(uploads.length, 3);
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
      assert.equal(
        fixture.visits[0].url.searchParams.get("screenshotRenderer"),
        "gradient-map",
      );
    },
  );

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
        [0, 3],
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
});
