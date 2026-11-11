import type { Page } from "playwright";
import { z } from "zod";

const nextPageSchema = z.object({
  props: z.object({
    pageProps: z.object({ json: z.string() }),
  }),
});

const tabPageSchema = z.object({
  json: z.object({
    tab: z.object({
      id: z.number().int().positive(),
      updatedAt: z.iso.datetime({ offset: true }),
    }),
  }),
});

export async function readRenderedTabVersion(
  page: Page,
  tabId: number,
): Promise<string> {
  try {
    // Read the hydrated preview itself, not Next.js's internal page payload.
    // App Router uses an RSC stream and does not emit __NEXT_DATA__.
    const preview = await page.locator("#tabPreviewScreenshotLight").evaluate(
      (element) => ({
        id: element.getAttribute("data-tab-id"),
        updatedAt: element.getAttribute("data-tab-version"),
      }),
    );
    if (preview.id !== null || preview.updatedAt !== null) {
      const { json } = tabPageSchema.parse({
        json: { tab: { id: Number(preview.id), updatedAt: preview.updatedAt } },
      });
      if (json.tab.id !== tabId) throw new Error("Tab ID mismatch");
      return new Date(json.tab.updatedAt).toISOString();
    }

    // Support older Pages Router deployments during rollout, but fail quickly
    // if neither contract exists rather than waiting for a nonexistent script.
    if ((await page.locator("#__NEXT_DATA__").count()) === 0) {
      throw new Error("Missing rendered tab revision");
    }
    const nextData = await page.locator("#__NEXT_DATA__").textContent();
    const nextPage = nextPageSchema.parse(JSON.parse(nextData ?? ""));
    // Autostrum serializes the public tab props with superjson. Its JSON data
    // already contains the ISO timestamp; the date-type metadata is not needed.
    const { json } = tabPageSchema.parse(
      JSON.parse(nextPage.props.pageProps.json),
    );
    if (json.tab.id !== tabId) throw new Error("Tab ID mismatch");
    return new Date(json.tab.updatedAt).toISOString();
  } catch {
    // Never label stale/unknown geometry with a made-up revision or the current
    // clock time. The app matches this value to tab.updatedAt before using it.
    throw new Error(`Cannot verify the rendered revision of tab ${tabId}`);
  }
}
