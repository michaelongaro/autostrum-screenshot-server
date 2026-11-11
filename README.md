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

Each successful capture uploads nine objects: the three original assets plus
400px and 800px card variants generated once with Sharp, before upload.

| Object key                             | Content type | Purpose                                            |
| -------------------------------------- | ------------ | -------------------------------------------------- |
| `<tabId>/masks-v1.png`                 | `image/png`  | One lossless atlas for all palettes and both modes |
| `<tabId>/light.jpeg`                   | `image/jpeg` | Light-mode gradient-map fallback                   |
| `<tabId>/dark.jpeg`                    | `image/jpeg` | Dark-mode gradient-map fallback                    |
| `<tabId>/card-v1/<width>/masks-v1.png` | `image/png`  | Card atlas, where width is 400 or 800              |
| `<tabId>/card-v1/<width>/light.jpeg`   | `image/jpeg` | Light-mode card fallback                           |
| `<tabId>/card-v1/<width>/dark.jpeg`    | `image/jpeg` | Dark-mode card fallback                            |

`type: "production"` uses `autostrum-screenshots`; `"development"` uses
`autostrum-screenshots-dev`. The atlas is 1200 × 3920 pixels: seven 1200 × 560 alpha
masks stacked in the exact role order defined in `src/services/screenshot-masks.ts`.
Keep that layout and capture logic in sync with Autostrum's
`src/utils/tabScreenshotMasks.ts` and `src/utils/captureTabScreenshotMasks.ts`.
Each card atlas also has seven stacked roles. Individual role heights are 187px
at width 400 and 373px at width 800. Layers are resized separately to prevent
bleeding between adjacent roles. JPEG variants are encoded directly from the
lossless capture, with quality 90 and 4:4:4 chroma subsampling.
Keep `src/services/screenshot-thumbnails.ts` in sync with Autostrum's
`src/utils/tabScreenshotThumbnails.ts` and `src/utils/createTabScreenshotThumbnails.ts`.

The server reads `data-tab-id` and `data-tab-version` from the hydrated
`#tabPreviewScreenshotLight` element and stores the ISO revision on every asset
in S3 metadata as `tab-version`. It checks the revision again after capture.
Deploy the matching Autostrum preview attributes with this worker change.
App Router pages do not emit `#__NEXT_DATA__`; relying on that Pages Router
payload caused captures to fail before uploading after the router migration.
The serialized Pages Router props remain supported as a fallback for older apps.
This requires no new request field, avoids guessing revisions, and labels the
atlas with the version actually captured.
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

Deploy both repositories to enable thumbnails. Either deployment order works:
the app falls back to original assets until a tab has matching thumbnails, and
older app deployments continue using the original assets. Existing
environment variables and the current Dockerfile are sufficient; the Docker build
already installs Chromium. New and edited tabs then generate thumbnails automatically.

To populate all thumbnails for older tabs, run the bulk script **from the Autostrum repo**
with production database/AWS credentials, substituting your deployed app URL:

```sh
npx tsx src/utils/bulkRetakeAllTabScreenshots.ts --bucket=autostrum-screenshots --base-url=https://YOUR_PRODUCTION_DOMAIN
```

That standalone script launches its own browser and does not require this server
to be running. Add `--tab=123` to capture one tab first. `--masks-only` updates the
full-size atlas and both mask thumbnails while preserving all JPEGs.

The app's APIs only fetch stored objects; they never resize on a request. JPEG
cards explicitly bypass Next Image optimization and use a native responsive
`picture` source. Masks are fetched directly. Railway uploads the generated
objects once per capture and is not in the image delivery path for visitors.

## Verify

```sh
npm test
```

Tests compile TypeScript and use a local HTML fixture with real Chromium and
mocked S3 uploads. They cover the unchanged API, atlas layout/opacity, revision
metadata, both buckets, invalid captures, upload failures, and per-tab sequencing.
They do not write to S3 or access the production app/database.
