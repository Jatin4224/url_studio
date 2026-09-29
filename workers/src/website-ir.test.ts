import { test } from "node:test";
import assert from "node:assert/strict";
import { createPresentationPlan } from "./website-ir.js";

test("product scenes skip tiny initials and profile images but retain dashboards", () => {
  const base = { id: "hero", semanticHint: "hero", headings: ["Build your product"], paragraphs: [], interactiveElements: [] };
  const images = [
    { assetId: "asset-al", alt: "AL", width: 32, height: 32 },
    { assetId: "asset-person", alt: "Team member portrait", width: 400, height: 400 },
    { assetId: "asset-dashboard", alt: "Product dashboard", width: 1200, height: 700 },
  ];
  const input = { title: "Example", description: "Example", sections: [{ ...base, images }] };
  const plan = createPresentationPlan(input);
  const product = plan.scenes.find((scene) => scene.type === "product");
  assert.deepEqual(product?.assetIds, ["asset-dashboard"]);
  const avatarsOnly = createPresentationPlan({ ...input, sections: [{ ...base, images: images.slice(0, 2) }] });
  assert.equal(avatarsOnly.scenes.some((scene) => scene.type === "product"), false);
});
