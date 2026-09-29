import type { Page } from "playwright";

export interface Box { x: number; y: number; width: number; height: number }

export interface RawElement {
  kind: "heading" | "text" | "image" | "action";
  tag: string;
  selector: string;
  /** Relative to the document, not the viewport. */
  box: Box;
  visible: boolean;
  /** aria-hidden or off-screen copy, e.g. a cloned carousel slide. */
  clone: boolean;
  /** Index into `sections`, or -1 when outside all of them. */
  section: number;
  /** Hash of the surrounding card's text: clones share it, similar cards don't. */
  context: number;
  text?: string;
  level?: number;
  href?: string;
  src?: string;
  alt?: string;
  role?: string;
  /** Styled like a button, whatever the tag. */
  button?: boolean;
  /** Inside a link to the home page, usually the logo. */
  homeLink?: boolean;
  style?: Record<string, string>;
}

export interface RawSection {
  tag: string;
  id?: string;
  selector: string;
  box: Box;
  backgroundColor: string;
  color: string;
}

export interface RawExtraction {
  url: string;
  title: string;
  description: string;
  viewport: { width: number; height: number };
  document: { width: number; height: number };
  sections: RawSection[];
  elements: RawElement[];
}

export async function extractRaw(page: Page): Promise<RawExtraction> {
  // tsx wraps named functions in __name(), which doesn't exist inside the page.
  await page.evaluate("globalThis.__name ??= (fn) => fn");
  return page.evaluate(() => {
    // Match the screenshot: finish entrance animations, reset looping ones (marquees).
    for (const animation of document.getAnimations()) {
      try {
        if (animation.effect?.getComputedTiming().iterations === Infinity) animation.cancel();
        else animation.finish();
      } catch { /* keep its current state */ }
    }

    const SECTION = "header, footer, nav, section, [role='region']";
    const ACTION = "a[href], button, [role='button'], input[type='submit']";
    const TEXT = "h1, h2, h3, h4, h5, h6, p, li, blockquote, figcaption";
    const clean = (text?: string | null) => (text ?? "").replace(/\s+/g, " ").trim();
    const hasWords = (text?: string | null) => /[\p{L}\p{N}]/u.test(text ?? "");
    const transparent = (color: string) => color === "transparent" || /\/ 0\)$|, 0\)$/.test(color);

    function boxOf(el: Element): Box {
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.x + scrollX), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) };
    }
    function selectorOf(el: Element): string {
      if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
      if (el === document.body || !el.parentElement) return "body";
      const sameTag = [...el.parentElement.children].filter((child) => child.tagName === el.tagName);
      return `${selectorOf(el.parentElement)} > ${el.tagName.toLowerCase()}:nth-of-type(${sameTag.indexOf(el) + 1})`;
    }
    function contextOf(el: Element, own: string) {
      let node = el.parentElement;
      for (let depth = 0; node && depth < 6; depth++, node = node.parentElement) {
        const text = clean(node.textContent);
        if (text.length >= own.length + 20) {
          let hash = 2166136261;
          for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
          return hash >>> 0;
        }
      }
      return 0;
    }

    // Sections: the outermost semantic blocks, or the large children of <main> on sites without them.
    const isShown = (el: Element) => el.checkVisibility() && el.getBoundingClientRect().height > 0;
    let roots = [...document.querySelectorAll(SECTION)]
      .filter((el) => isShown(el) && !el.parentElement?.closest(SECTION));
    if (roots.length < 2) {
      roots = [...(document.querySelector("main") ?? document.body).children]
        .filter((el) => isShown(el) && el.getBoundingClientRect().height >= 100);
    }
    const sections: RawSection[] = roots.map((el) => {
      const style = getComputedStyle(el);
      return {
        tag: el.tagName.toLowerCase(), id: el.id || undefined, selector: selectorOf(el), box: boxOf(el),
        backgroundColor: transparent(style.backgroundColor) ? getComputedStyle(document.body).backgroundColor : style.backgroundColor,
        color: style.color,
      };
    });

    const elements: RawElement[] = [];
    const captured = new Set<Element>();
    const insideCaptured = (el: Element) => {
      for (let parent = el.parentElement; parent; parent = parent.parentElement) if (captured.has(parent)) return true;
      return false;
    };
    for (const el of document.body.querySelectorAll("*")) {
      if (el.matches("script, style, noscript, template") || el.parentElement?.closest("svg")) continue;
      const home = el.closest("a[href]") as HTMLAnchorElement | null;
      const homeLink = home ? new URL(home.href).origin === location.origin && new URL(home.href).pathname === "/" : false;
      const style = getComputedStyle(el);
      let fields: Partial<RawElement>;

      if (el.matches(ACTION) && !el.parentElement?.closest(ACTION)) {
        captured.add(el);
        fields = {
          kind: "action", text: clean((el as HTMLElement).innerText) || clean(el.getAttribute("aria-label")),
          href: (el as HTMLAnchorElement).href || undefined,
          button: el.tagName === "BUTTON" || !transparent(style.backgroundColor),
          style: { backgroundColor: style.backgroundColor, color: style.color },
        };
      } else if (el.matches("img, video") || (el.matches("svg") && homeLink)) {
        const media = el as HTMLImageElement;
        fields = { kind: "image", src: media.currentSrc || media.src || undefined, alt: clean(media.alt || el.getAttribute("aria-label")) || undefined, homeLink };
      } else if (insideCaptured(el)) {
        continue; // already part of a captured text block or action
      } else if (el.matches(TEXT) || [...el.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && hasWords(node.textContent))) {
        const text = clean((el as HTMLElement).innerText);
        // A list item that only wraps a link is captured as the link.
        if (clean((el.querySelector(ACTION) as HTMLElement | null)?.innerText) === text) continue;
        captured.add(el);
        const level = Number(el.tagName[1]) || undefined;
        fields = {
          kind: level ? "heading" : "text", text: text.slice(0, 500), level,
          style: level ? { fontSize: style.fontSize, fontWeight: style.fontWeight, color: style.color } : undefined,
        };
      } else {
        continue;
      }

      const box = boxOf(el);
      elements.push({
        ...fields,
        kind: fields.kind!,
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? undefined,
        selector: selectorOf(el),
        box,
        visible: box.width > 0 && box.height > 0 && el.checkVisibility({ checkVisibilityCSS: true }),
        clone: Boolean(el.closest("[aria-hidden='true']")) || box.x + box.width <= 0 || box.x >= innerWidth,
        section: roots.findIndex((root) => root.contains(el)),
        context: contextOf(el, fields.text ?? ""),
      });
    }

    return {
      url: location.href,
      title: document.title,
      description: document.querySelector<HTMLMetaElement>("meta[name='description']")?.content ?? "",
      viewport: { width: innerWidth, height: innerHeight },
      document: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      sections,
      elements,
    };
  });
}
