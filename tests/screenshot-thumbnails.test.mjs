import assert from "node:assert/strict";
import { test } from "node:test";
import sharp from "sharp";
import { createTabScreenshotThumbnails } from "../dist/services/screenshot-thumbnails.js";

test("thumbnail atlas resizes roles independently without bleeding at boundaries", async () => {
  const alphas = [255, 0, 64, 128, 191, 32, 224];
  const layers = alphas.map((alpha) => {
    const layer = Buffer.alloc(1200 * 560 * 4, 255);
    for (let pixel = 0; pixel < 1200 * 560; pixel++) {
      layer[pixel * 4 + 3] = alpha;
    }
    return layer;
  });
  const masks = await sharp(Buffer.concat(layers), {
    raw: { width: 1200, height: 560 * 7, channels: 4 },
  })
    .png()
    .toBuffer();
  const thumbnails = await createTabScreenshotThumbnails(42, { masks });
  assert.equal(thumbnails.length, 2, "masks-only capture preserves JPEGs");
  for (const thumbnail of thumbnails) {
    const { data, info } = await sharp(thumbnail.body)
      .raw()
      .toBuffer({ resolveWithObject: true });
    const height = info.height / 7;
    for (const [role, alpha] of alphas.entries()) {
      for (const y of [role * height, (role + 1) * height - 1]) {
        for (const x of [0, Math.floor(info.width / 2), info.width - 1]) {
          assert.equal(data[(y * info.width + x) * 4 + 3], alpha);
        }
      }
    }
  }
});
