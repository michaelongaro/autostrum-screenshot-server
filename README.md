```
npm install
npm run dev
```

```
open http://localhost:3000
```

Environment variables:

```
PORT=3001
BASE_URL=http://localhost:3000
SCREENSHOT_SECRET=your-shared-secret
AWS_ACCESS_KEY_ID=...
AWS_SECRET_ACCESS_KEY=...
PLAYWRIGHT_IDLE_CLOSE_MS=60000
```

The screenshot service keeps a shared Playwright browser alive while screenshots are in flight and closes it after `PLAYWRIGHT_IDLE_CLOSE_MS` of idleness. Screenshot capture closes the Playwright context before image resizing and S3 upload begin.
