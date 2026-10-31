// Keep the storage contract and generation in sync with Autostrum's
// tabScreenshotThumbnails.ts and createTabScreenshotThumbnails.ts utilities.
import sharp from "sharp";
import {
  TAB_SCREENSHOT_MASK_FORMAT,
  TAB_SCREENSHOT_MASK_HEIGHT,
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
  captures: { masks: Buffer; light?: Buffer; dark?: Buffer },
): Promise<TabScreenshotAsset[]> {
  // Decode the large atlas once, rather than once per role and output size.
  const { data, info } = await sharp(captures.masks)
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
  const layerBytes = TAB_SCREENSHOT_MASK_WIDTH * TAB_SCREENSHOT_MASK_HEIGHT * 4;
  const variants = await Promise.all(
    TAB_SCREENSHOT_THUMBNAIL_WIDTHS.map(async (width) => {
      const height = Math.round(
        (width * TAB_SCREENSHOT_MASK_HEIGHT) / TAB_SCREENSHOT_MASK_WIDTH,
      );
      const layers = await Promise.all(
        TAB_SCREENSHOT_MASK_ROLES.map((_, index) =>
          sharp(data.subarray(index * layerBytes, (index + 1) * layerBytes), {
            raw: {
              width: TAB_SCREENSHOT_MASK_WIDTH,
              height: TAB_SCREENSHOT_MASK_HEIGHT,
              channels: 4,
            },
          })
            .resize(width, height)
            .raw()
            .toBuffer(),
        ),
      );
      const atlas = await sharp(Buffer.concat(layers), {
        raw: {
          width,
          height: height * TAB_SCREENSHOT_MASK_ROLES.length,
          channels: 4,
        },
      })
        .png({ compressionLevel: 9 })
        .toBuffer();
      const assets: TabScreenshotAsset[] = [
        {
          key: getTabScreenshotThumbnailKey(
            tabId,
            `${TAB_SCREENSHOT_MASK_FORMAT}.png`,
            width,
          ),
          body: atlas,
          contentType: "image/png",
        },
      ];
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
      return assets;
    }),
  );
  return variants.flat();
}
