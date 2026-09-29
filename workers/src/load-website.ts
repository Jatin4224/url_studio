import { extractRaw } from "./extract-raw.js";
import { startPublicProxy } from "./public-proxy.js";
import { scrollPage } from "./scroll-page.js";
import { validateWebsiteUrl } from "./validate-url.js";
import { chromium, errors, type Page } from "playwright";
import {
  buildWebsiteIR,
  createPresentationPlan,
  prepareForAI,
  WebsiteIR,
} from "./website-ir.js";
import { mkdir, writeFile } from "node:fs/promises";

export async function loadWebsite(
  input: any,
  dir: string,
  onStep: (step: number) => void,
) {
  onStep(0);
  const result = validateWebsiteUrl(input);
  if (!result.url) throw new Error(result.error);

  const proxy = await startPublicProxy();
  const browser = await chromium
    .launch({
      timeout: 10_000,
      proxy: { server: proxy.url },
      args: [
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
      ],
    })
    .catch(async (error) => {
      await proxy.close();
      throw error;
    });

  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
      serviceWorkers: "block",
      acceptDownloads: false,
    });
    await context.routeWebSocket("**/*", (socket) => socket.close());
    const page = await context.newPage();
    const response = await page.goto(result.url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });

    if (!response || response.status() >= 400)
      throw new Error(
        `Website returned HTTP ${response?.status() ?? "no response"}.`,
      );
    const ignoreTimeout = (error: unknown) => {
      if (!(error instanceof errors.TimeoutError)) throw error;
    };

    await page
      .waitForLoadState("load", { timeout: 5_000 })
      .catch(ignoreTimeout);
    await page
      .waitForFunction(
        () =>
          document.fonts.status === "loaded" &&
          Array.from(document.images).every((image) => {
            const box = image.getBoundingClientRect();
            return (
              image.complete ||
              !(
                box.bottom > 0 &&
                box.top < innerHeight &&
                box.right > 0 &&
                box.left < innerWidth
              )
            );
          }),
        undefined,
        { timeout: 3_000 },
      )
      .catch(ignoreTimeout);

    await page.waitForTimeout(1_000);
    await scrollPage(page);
    const raw = await extractRaw(page);
    if (!raw.sections.length || !raw.elements.length)
      throw new Error("No useful website content was found.");
    const websiteIR = buildWebsiteIR(raw, result.url);
    onStep(1);

    const presentationPlan = createPresentationPlan(prepareForAI(websiteIR));
    if (!presentationPlan.scenes.length)
      throw new Error("No useful sections were found for a presentation.");
    onStep(2);
    return {
      websiteIR,
      presentationPlan,
      sceneReferences: await captureSceneReferences(
        page,
        websiteIR,
        presentationPlan,
        dir,
      ),
    };
  } finally {
    await browser.close().finally(() => proxy.close());
  }
}

async function captureSceneReferences(
  page: Page,
  ir: WebsiteIR,
  plan: ReturnType<typeof createPresentationPlan>,
  dir: string,
) {
  await mkdir(dir, { recursive: true });

  await page.evaluate(() => {
    for (const el of document.querySelectorAll<HTMLElement>("body *")) {
      if (["fixed", "sticky"].includes(getComputedStyle(el).position))
        el.style.visibility = "hidden";
    }
  });
  const cdp = await page.context().newCDPSession(page);
  const captures = [];
  for (const scene of plan.scenes) {
    const assetId = scene.type === "product" ? scene.assetIds?.[0] : undefined;
    const target = assetId
      ? ir.assets.find((a) => a.id === assetId)
      : ir.sections.find((s) => s.id === scene.sourceSectionIds?.[0]);
    if (!target) continue;
    const path = `${dir}/${scene.id}.png`;
    const locator = page.locator(target.selector);
    const single = (await locator.count()) === 1;
    let clip = target.box;
    if (single) {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
      await page.waitForTimeout(700);
      const box = await locator.boundingBox();
      const scroll = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
      if (box)
        clip = {
          x: box.x + scroll.x,
          y: box.y + scroll.y,
          width: box.width,
          height: box.height,
        };
    }
    const capture = async () =>
      Buffer.from(
        (
          await cdp.send("Page.captureScreenshot", {
            format: "png",
            captureBeyondViewport: true,
            clip: { ...clip, scale: 2 },
          })
        ).data,
        "base64",
      );
    await writeFile(path, await capture());
    const hideText = await page.addStyleTag({ content: textless });
    await page.waitForTimeout(100);
    await writeFile(path.replace(/\.png$/, "-plate.png"), await capture());
    await hideText.evaluate((el) => (el as Element).remove());
    const layers =
      single && !assetId
        ? await locator.evaluate(findLayers)
        : { width: clip.width, height: clip.height, surfaces: [], raster: !!assetId };
    await writeFile(path.replace(/\.png$/, ".json"), JSON.stringify(layers));
    captures.push({ sceneId: scene.id, path });
  }
  return captures;
}

const textless = `*, *::before, *::after { color: transparent !important; -webkit-text-fill-color: transparent !important;
  text-shadow: none !important; caret-color: transparent !important; } *::placeholder { color: transparent !important; }`;

function findLayers(root: Element) {
  const origin = root.getBoundingClientRect();
  const area = origin.width * origin.height;
  const box = (el: Element) => {
    const b = el.getBoundingClientRect();
    return {
      x: b.x - origin.x,
      y: b.y - origin.y,
      width: b.width,
      height: b.height,
    };
  };
  const surfaces: (ReturnType<typeof box> & { radius: number })[] = [];
  const visit = (el: Element) => {
    for (const child of Array.from(el.children)) {
      const style = getComputedStyle(child);
      if (
        style.visibility === "hidden" ||
        style.display === "none" ||
        Number(style.opacity) === 0
      )
        continue;
      const b = child.getBoundingClientRect();
      const painted =
        !["rgba(0, 0, 0, 0)", "transparent"].includes(style.backgroundColor) ||
        ["top", "right", "bottom", "left"].some(
          (side) =>
            parseFloat(style.getPropertyValue(`border-${side}-width`)) > 0 &&
            style.getPropertyValue(`border-${side}-style`) !== "none",
        ) ||
        style.boxShadow !== "none" ||
        ["IMG", "VIDEO", "CANVAS", "PICTURE"].includes(child.tagName);
      if (
        painted &&
        b.width >= 160 &&
        b.height >= 48 &&
        b.width * b.height < area * 0.6
      )
        surfaces.push({
          ...box(child),
          radius: parseFloat(style.borderTopLeftRadius) || 0,
        });
      else visit(child);
    }
  };
  visit(root);
  const heading = root.querySelector("h1, h2");
  // Chart-like visuals Higgsfield may bring to life: canvases, SVG charts, and groups of three or more
  // text-free painted shapes (bars). Only the largest is kept.
  const shapes = (el: Element) =>
    Array.from(el.children).filter((child) => {
      const b = child.getBoundingClientRect(),
        s = getComputedStyle(child);
      return (
        !child.textContent?.trim() &&
        b.width >= 4 &&
        b.height >= 4 &&
        !["rgba(0, 0, 0, 0)", "transparent"].includes(s.backgroundColor)
      );
    }).length;
  const count = (el: Element) =>
    el.tagName === "CANVAS"
      ? 50
      : el.tagName.toLowerCase() === "svg"
        ? el.querySelectorAll("rect, path, line, circle, polyline").length
        : shapes(el);
  const data = Array.from(
    root.querySelectorAll("canvas, svg, div, span, ul, ol, figure"),
  )
    .map((el) => ({ ...box(el), shapes: count(el) }))
    .filter(
      (b) =>
        b.shapes >= (b.shapes === 50 ? 1 : 3) &&
        b.width >= 60 &&
        b.height >= 24,
    )
    .sort((a, b) => b.width * b.height - a.width * a.height)
    .slice(0, 16);
  return {
    width: origin.width,
    height: origin.height,
    heading: heading ? box(heading) : undefined,
    surfaces: surfaces.slice(0, 16),
    data,
  };
}
