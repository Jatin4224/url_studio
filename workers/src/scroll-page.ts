import type { Page } from "playwright";

/** Scrolls down in 720px steps (to 12,000px or ten seconds) so lazy and scroll-triggered content loads, then returns to the top. */
export async function scrollPage(page: Page) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    await page.evaluate(() => window.scrollTo({ top: Math.min(scrollY + 720, 12_000 - innerHeight), behavior: "instant" }));
    // Give lazy images and scroll-triggered content a moment to appear, then check whether the bottom was reached.
    await page.waitForTimeout(350);
    const bottom = await page.evaluate(() => {
      const end = scrollY + innerHeight;
      return end >= 12_000 || end >= Math.max(document.documentElement.scrollHeight, document.body.scrollHeight) - 1;
    });
    if (bottom) break;
  }
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
  await page.waitForTimeout(500);
}
