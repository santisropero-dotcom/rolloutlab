export interface Product {
  id: string;
  name: string;
  description: string;
  /** Price in cents to avoid floating-point rounding. */
  priceCents: number;
}

/** Synthetic catalog for the sample storefront. No real products or prices. */
export const catalog: readonly Product[] = [
  {
    id: "sku-mug",
    name: "Canary Mug",
    description: "Ceramic mug for watching early rollout metrics.",
    priceCents: 1400,
  },
  {
    id: "sku-tee",
    name: "Cohort Tee",
    description: "Cotton t-shirt. Same size every time you come back.",
    priceCents: 2200,
  },
  {
    id: "sku-notebook",
    name: "Guardrail Notebook",
    description: "Dotted notebook for writing down thresholds.",
    priceCents: 900,
  },
  {
    id: "sku-stickers",
    name: "Feature Flag Stickers",
    description: "Pack of six vinyl stickers.",
    priceCents: 500,
  },
];

export function findProduct(id: string): Product | undefined {
  return catalog.find((product) => product.id === id);
}
