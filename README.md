# Autostrum screenshot server

Captures recolorable mask atlases and light/dark fallback JPEGs for published tabs.

## Run locally

```sh
npm install
npx playwright install chromium
npm run dev
```

Health check: `http://localhost:3001/health` (or your configured `PORT`).

Environment variables:

```dotenv
PORT=3001
BASE_URL=http://localhost:3000
SCREENSHOT_SECRET=your-shared-secret
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
PLAYWRIGHT_IDLE_CLOSE_MS=60000
```

`BASE_URL` must point to the updated Autostrum app, which renders the static
screenshot previews. In production, use the production site's URL. This server
does not need database credentials. Keep the shared secret aligned with the app.

## Capture API and assets

The existing `POST /screenshot/capture` request is unchanged:

```json
{
  "tabId": 42,
  "tabTitle": "Example song",
  "type": "production",
  "secret": "your-shared-secret"
}
```

Each successful capture uploads three objects:

| Object key             | Content type | Purpose                                            |
| ---------------------- | ------------ | -------------------------------------------------- |
| `<tabId>/masks-v1.png` | `image/png`  | One lossless atlas for all palettes and both modes |
| `<tabId>/light.jpeg`   | `image/jpeg` | Light-mode gradient-map fallback                   |
| `<tabId>/dark.jpeg`    | `image/jpeg` | Dark-mode gradient-map fallback                    |

`type: "production"` uses `autostrum-screenshots`; `"development"` uses
`autostrum-screenshots-dev`. The atlas is 1200 × 3920 pixels: seven 1200 × 560 alpha
masks stacked in the exact role order defined in `src/services/screenshot-masks.ts`.
Keep that layout and capture logic in sync with Autostrum's
`src/utils/tabScreenshotMasks.ts` and `src/utils/captureTabScreenshotMasks.ts`.

The server reads the rendered tab's `updatedAt` from the page's serialized Next.js
props and stores its ISO value in S3 metadata as `tab-version`. This requires no
new request field or additional Autostrum deployment for the timestamp. It avoids
guessing revisions and labels the atlas with the version actually captured.
Autostrum rejects an atlas whose metadata does not match the displayed tab.

Capture fails before uploading assets if the tab ID/revision cannot be verified
or the preview contains a color outside the supported mask roles. An upload
failure returns an error after all in-flight uploads finish. Captures for the same
bucket/tab are serialized within the server process; different tabs can run
concurrently in separate browser contexts.

The service shares a Playwright browser across active captures, closes each
context when capture finishes, and closes the browser after
`PLAYWRIGHT_IDLE_CLOSE_MS` of inactivity.

## Deploy and backfill

Deploy the mask-compatible Autostrum app before deploying this server. Existing
environment variables and the current Dockerfile are sufficient; the Docker build
already installs Chromium. New and edited tabs then generate masks automatically.

To populate masks for older tabs, run the bulk script **from the Autostrum repo**
with production database/AWS credentials, substituting your deployed app URL:

```sh
npx tsx src/utils/bulkRetakeAllTabScreenshots.ts --masks-only --bucket=autostrum-screenshots --base-url=https://YOUR_PRODUCTION_DOMAIN
```

That standalone script launches its own browser and does not require this server
to be running. Missing or outdated masks fall back to the existing JPEGs in the app.

## Verify

```sh
npm test
```

Tests compile TypeScript and use a local HTML fixture with real Chromium and
mocked S3 uploads. They cover the unchanged API, atlas layout/opacity, revision
metadata, both buckets, invalid captures, upload failures, and per-tab sequencing.
They do not write to S3 or access the production app/database.
