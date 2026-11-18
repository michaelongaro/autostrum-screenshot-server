// Keep the storage contract and generation in sync with Autostrum's
// tabScreenshotThumbnails.ts and createTabScreenshotThumbnails.ts utilities.
import sharp from "sharp";
import {
  encodeTabScreenshotMaskAtlas,
  TAB_SCREENSHOT_MASK_FORMAT,
  TAB_SCREENSHOT_MASK_HEIGHT,
  TAB_SCREENSHOT_MASK_LAYER_BYTES,
  TAB_SCREENSHOT_MASK_ROLES,
  TAB_SCREENSHOT_MASK_WIDTH,
} from "./screenshot-masks.js";
export const TAB_SCREENSHOT_THUMBNAIL_FORMAT = "card-v1";
export const TAB_SCREENSHOT_THUMBNAIL_WIDTHS = [400, 800] as const;
export type TabScreenshotThumbnailWidth =
  (typeof TAB_SCREENSHOT_THUMBNAIL_WIDTHS)[number];

export function isTabScreenshotThumbnailWidth(
  value: unknown,
): value is TabScreenshotThumbnailWidth {
  return value === 400 || value === 800;
}

export function getTabScreenshotThumbnailWidth(pixelWidth: number) {
  return pixelWidth <= 400 ? 400 : 800;
}

export function getTabScreenshotThumbnailKey(
  tabId: number | string,
  filename: string,
  width: TabScreenshotThumbnailWidth,
) {
  return `${tabId}/${TAB_SCREENSHOT_THUMBNAIL_FORMAT}/${width}/${filename}`;
}

export interface TabScreenshotAsset {
  key: string;
  body: Buffer;
  contentType: string;
}

// JPEGs start from lossless captures. Resize each mask separately so the
// resampling kernel cannot mix adjacent roles at the atlas boundaries.
export async function createTabScreenshotThumbnails(
  tabId: number,
  captures: ({ masks: Buffer } | { rawMasks: Buffer }) & {
    light?: Buffer;
    dark?: Buffer;
  },
): Promise<TabScreenshotAsset[]> {
  const data = "rawMasks" in captures
    ? captures.rawMasks
    : await decodeMaskAtlas(captures.masks);
  const layerBytes = TAB_SCREENSHOT_MASK_LAYER_BYTES;
  if (data.length !== layerBytes * TAB_SCREENSHOT_MASK_ROLES.length) {
    throw new Error("Invalid source mask atlas geometry");
  }

  const assets: TabScreenshotAsset[] = [];
  for (const width of TAB_SCREENSHOT_THUMBNAIL_WIDTHS) {
    const height = Math.round(
      (width * TAB_SCREENSHOT_MASK_HEIGHT) / TAB_SCREENSHOT_MASK_WIDTH,
    );
    const thumbnailLayerBytes = width * height * 4;
    const atlas = Buffer.allocUnsafe(
      thumbnailLayerBytes * TAB_SCREENSHOT_MASK_ROLES.length,
    );
    for (const index of TAB_SCREENSHOT_MASK_ROLES.keys()) {
      const layer = await sharp(
        data.subarray(index * layerBytes, (index + 1) * layerBytes),
        {
          raw: {
            width: TAB_SCREENSHOT_MASK_WIDTH,
            height: TAB_SCREENSHOT_MASK_HEIGHT,
            channels: 4,
          },
        },
      )
        .resize(width, height)
        .raw()
        .toBuffer();
      layer.copy(atlas, index * thumbnailLayerBytes);
    }
    assets.push({
      key: getTabScreenshotThumbnailKey(
        tabId,
        `${TAB_SCREENSHOT_MASK_FORMAT}.png`,
        width,
      ),
      body: await encodeTabScreenshotMaskAtlas(atlas, width, height),
      contentType: "image/png",
    });
    for (const theme of ["light", "dark"] as const) {
      const capture = captures[theme];
      if (!capture) continue;
      assets.push({
        key: getTabScreenshotThumbnailKey(tabId, `${theme}.jpeg`, width),
        body: await sharp(capture)
          .resize({ width })
          .jpeg({ quality: 90, chromaSubsampling: "4:4:4" })
          .toBuffer(),
        contentType: "image/jpeg",
      });
    }
  }
  return assets;
}

async function decodeMaskAtlas(masks: Buffer): Promise<Buffer> {
  const { data, info } = await sharp(masks)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  if (
    info.width !== TAB_SCREENSHOT_MASK_WIDTH ||
    info.height !==
      TAB_SCREENSHOT_MASK_HEIGHT * TAB_SCREENSHOT_MASK_ROLES.length ||
    info.channels !== 4
  ) {
    throw new Error("Invalid source mask atlas geometry");
  }
  return data;
}
