import { Box, RawElement, RawExtraction } from "./extract-raw.js";

export interface TextElement {
  id: string;
  text: string;
  level?: number;
  box: Box;
  selector: string;
  style?: Record<string, string>;
}
export interface ImageElement {
  assetId: string;
  box: Box;
}
export interface InteractiveElement {
  id: string;
  element: string;
  role?: string;
  appearance: "button" | "link";
  text: string;
  href?: string;
  box: Box;
  selector: string;
}

export interface WebsiteSection {
  id: string;
  semanticHint?: string;
  box: Box;
  selector: string;
  headings: TextElement[];
  paragraphs: TextElement[];
  images: ImageElement[];
  interactiveElements: InteractiveElement[];
  visual: { backgroundColor: string; color: string };
}

export interface WebsiteAsset {
  id: string;
  sectionId: string;
  src?: string;
  alt?: string;
  box: Box;
  selector: string;
}

export interface WebsiteIR {
  page: {
    url: string;
    finalUrl: string;
    title?: string;
    description?: string;
    viewport: { width: number; height: number };
    document: { width: number; height: number };
  };
  sections: WebsiteSection[];
  assets: WebsiteAsset[];
  stats: { rawElements: number; keptElements: number };
}

function assetUrl(src?: string) {
  if (!src) return "inline-svg";
  const url = new URL(src);
  const inner = url.searchParams.get("url");
  if (inner && url.pathname.endsWith("/_next/image"))
    return new URL(inner, url).href;
  for (const param of ["w", "q", "dpl"]) url.searchParams.delete(param);
  return url.href;
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .slice(0, 4)
    .join("-");

export function buildWebsiteIR(
  raw: RawExtraction,
  requestedUrl: string,
): WebsiteIR {
  const unique = new Map<string, RawElement>();
  for (const element of raw.elements) {
    if (
      !element.visible ||
      (element.kind !== "image" && !/[\p{L}\p{N}]/u.test(element.text ?? ""))
    )
      continue;
    const key =
      element.kind === "image"
        ? `image|${element.section}|${assetUrl(element.src)}`
        : `${element.kind}|${element.text!.toLowerCase()}|${element.href ?? ""}|${element.context}`;

    const kept = unique.get(key);
    if (!kept || (kept.clone && !element.clone)) unique.set(key, element);
  }

  const heroIndex = raw.sections.findIndex((_, i) =>
    [...unique.values()].some((e) => e.section === i && e.level === 1),
  );
  const usedIds = new Set<string>();
  const sections: WebsiteSection[] = raw.sections.map((section, i) => {
    const hint =
      i === heroIndex
        ? "hero"
        : ["header", "footer", "nav"].includes(section.tag)
          ? section.tag
          : section.id && /^[a-z][a-z-]{2,30}$/i.test(section.id)
            ? slug(section.id)
            : undefined;
    const id =
      hint && !usedIds.has(`section-${hint}`)
        ? `section-${hint}`
        : `section-${i + 1}`;

    usedIds.add(id);
    return {
      id,
      semanticHint: hint,
      box: section.box,
      selector: section.selector,
      headings: [],
      paragraphs: [],
      images: [],
      interactiveElements: [],
      visual: {
        backgroundColor: section.backgroundColor,
        color: section.color,
      },
    };
  });

  const nearest = (element: RawElement) => {
    const y = element.box.y + element.box.height / 2;
    const gap = (box: Box) => Math.max(box.y - y, y - (box.y + box.height), 0);
    return sections.reduce((best, section) =>
      gap(section.box) < gap(best.box) ? section : best,
    );
  };
  const assets = new Map<string, WebsiteAsset>();
  const counters = { heading: 0, text: 0, action: 0 };
  for (const element of unique.values()) {
    const section = sections[element.section] ?? nearest(element);
    const { box, selector } = element;
    if (element.kind === "heading") {
      section.headings.push({
        id: `heading-${++counters.heading}`,
        text: element.text!,
        level: element.level,
        box,
        selector,
        style: element.style,
      });
    } else if (element.kind === "text") {
      section.paragraphs.push({
        id: `text-${++counters.text}`,
        text: element.text!,
        box,
        selector,
      });
    } else if (element.kind === "action") {
      section.interactiveElements.push({
        id: `action-${++counters.action}`,
        element: element.tag,
        role: element.role,
        appearance: element.button ? "button" : "link",
        text: element.text!,
        href: element.href,
        box,
        selector,
      });
    } else {
      const url = assetUrl(element.src);
      let asset = assets.get(url);
      if (!asset) {
        const name = element.homeLink
          ? "logo"
          : slug(
              element.alt ??
                url
                  .split("/")
                  .pop()!
                  .replace(/\.\w+$/, ""),
            ) || "image";
        let id = `asset-${name}`;
        for (let n = 2; [...assets.values()].some((a) => a.id === id); n++)
          id = `asset-${name}-${n}`;
        asset = {
          id,
          sectionId: section.id,
          src: element.src,
          alt: element.alt,
          box,
          selector,
        };
        assets.set(url, asset);
      }
      section.images.push({ assetId: asset.id, box });
    }
  }

  return {
    page: {
      url: requestedUrl,
      finalUrl: raw.url,
      title: raw.title || undefined,
      description: raw.description || undefined,
      viewport: raw.viewport,
      document: raw.document,
    },
    sections,
    assets: [...assets.values()],
    stats: { rawElements: raw.elements.length, keptElements: unique.size },
  };
}

export function prepareForAI(ir: WebsiteIR) {
  const alt = new Map(ir.assets.map((asset) => [asset.id, asset.alt]));
  return {
    title: ir.page.title,
    description: ir.page.description,
    sections: ir.sections.map((section) => ({
      id: section.id,
      semanticHint: section.semanticHint,
      headings: section.headings.map((heading) => heading.text),
      paragraphs: section.paragraphs.map((paragraph) => paragraph.text),
      images: section.images.map((image) => ({
        assetId: image.assetId,
        alt: alt.get(image.assetId),
        width: image.box.width,
        height: image.box.height,
      })),
      interactiveElements: section.interactiveElements.map(
        ({ text, href }) => ({ text, href }),
      ),
    })),
  };
}

type AISection = ReturnType<typeof prepareForAI>["sections"][number];

export function createPresentationPlan(input: ReturnType<typeof prepareForAI>) {
  // Small profile pictures are not product screenshots, even when named only by initials.
  const productIds = new Set(input.sections.flatMap((section) => section.images)
    .filter((image) => image.width >= 240 && image.height >= 140 &&
      !/logo|avatar|testimonial|profile|portrait|headshot|user.?photo|team.?member/i.test(`${image.assetId} ${image.alt ?? ""}`))
    .map((image) => image.assetId));
  const isLikelyProductImage = (id: string) => productIds.has(id);
  const content = input.sections.filter(
    (s) =>
      !["header", "footer", "nav"].includes(s.semanticHint ?? "") &&
      s.headings.length,
  );
  const hero =
    input.sections.find((s) => s.semanticHint === "hero") ?? content[0];
  const productSection = [hero, ...content].find((s) =>
    s?.images.some((image) => isLikelyProductImage(image.assetId)),
  );
  const productImage = productSection?.images.find((image) =>
    isLikelyProductImage(image.assetId),
  );
  const features =
    input.sections.find((s) => s.semanticHint === "features") ??
    content.find((s) => s !== hero && s.headings.length > 1) ??
    content.find((s) => s !== hero);
  const closing =
    [...content]
      .reverse()
      .find((s) => s !== hero && s.interactiveElements.length) ??
    content.at(-1);

  const scene = (
    type: string,
    section: AISection | undefined,
    duration: number,
    priority: number,
    extra: object = {},
  ) =>
    section && {
      type,
      sourceSectionIds: [section.id],
      assetIds: section.images
        .map((image) => image.assetId)
        .filter(isLikelyProductImage),
      headline: section.headings[0],
      supportingText: section.paragraphs[0],
      duration,
      priority,
      ...extra,
    };
  const used = new Set([hero, features, closing].map((s) => s?.id));
  const richness = (s: AISection) =>
    s.headings.length * 2 +
    s.images.length * 2 +
    s.paragraphs.length +
    s.interactiveElements.length;
  const others = content
    .filter((s) => !used.has(s.id))
    .sort((a, b) => richness(b) - richness(a));
  const order = (s?: AISection) =>
    input.sections.findIndex((section) => section.id === s?.id);
  const scenes = [
    { at: -1, scene: scene("hero", hero, 5, 0) },
    {
      at: order(productSection) + 0.5,
      scene:
        productImage &&
        scene("product", productSection, 6, 2, {
          assetIds: [productImage.assetId],
          headline: productImage.alt,
          supportingText: undefined,
        }),
    },
    {
      at: order(features),
      scene: scene("features", features, 6, 3, {
        points:
          features &&
          (features.headings.length > 1
            ? features.headings.slice(1, 4)
            : features.paragraphs.slice(1, 4)),
      }),
    },
    ...others.map((s, i) => ({
      at: order(s),
      scene: scene("section", s, 5, 4 + i),
    })),
    {
      at: Infinity,
      scene: scene("closing", closing, 4, 1, {
        cta: closing?.interactiveElements[0],
      }),
    },
  ];
  return {
    scenes: scenes
      .filter((s) => s.scene)
      .sort((a, b) => a.at - b.at)
      .map((s, i) => ({ id: `scene-${i + 1}`, ...s.scene! })),
  };
}
