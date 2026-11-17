import { describe, expect, it } from "vitest";
import { catalog, findProduct } from "./catalog";
import {
  FLAT_SHIPPING_CENTS,
  MAX_QUANTITY,
  addItem,
  cartTotals,
  formatPrice,
  removeItem,
  setQuantity,
  type Cart,
} from "./cart";

describe("catalog", () => {
  it("has unique ids and positive integer prices", () => {
    const ids = new Set(catalog.map((product) => product.id));
    expect(ids.size).toBe(catalog.length);
    for (const product of catalog) {
      expect(Number.isInteger(product.priceCents)).toBe(true);
      expect(product.priceCents).toBeGreaterThan(0);
    }
  });
});

describe("cart", () => {
  it("adds a new line and increments an existing one", () => {
    let cart: Cart = [];
    cart = addItem(cart, "sku-mug");
    cart = addItem(cart, "sku-mug");
    cart = addItem(cart, "sku-tee");
    expect(cart).toEqual([
      { productId: "sku-mug", quantity: 2 },
      { productId: "sku-tee", quantity: 1 },
    ]);
  });

  it("does not mutate the previous cart", () => {
    const before: Cart = [{ productId: "sku-mug", quantity: 1 }];
    addItem(before, "sku-mug");
    expect(before).toEqual([{ productId: "sku-mug", quantity: 1 }]);
  });

  it("clamps quantity and removes lines set to zero", () => {
    const cart: Cart = [{ productId: "sku-mug", quantity: 1 }];
    expect(setQuantity(cart, "sku-mug", 99)).toEqual([
      { productId: "sku-mug", quantity: MAX_QUANTITY },
    ]);
    expect(setQuantity(cart, "sku-mug", 0)).toEqual([]);
    expect(removeItem(cart, "sku-mug")).toEqual([]);
  });

  it("rejects non-integer quantities", () => {
    expect(() => setQuantity([], "sku-mug", 1.5)).toThrow(RangeError);
  });
});

describe("cartTotals", () => {
  it("returns zeros for an empty cart", () => {
    expect(cartTotals([], findProduct)).toEqual({
      itemCount: 0,
      subtotalCents: 0,
      shippingCents: 0,
      totalCents: 0,
    });
  });

  it("charges flat shipping below the free-shipping threshold", () => {
    const totals = cartTotals([{ productId: "sku-mug", quantity: 2 }], findProduct);
    expect(totals).toEqual({
      itemCount: 2,
      subtotalCents: 2800,
      shippingCents: FLAT_SHIPPING_CENTS,
      totalCents: 2800 + FLAT_SHIPPING_CENTS,
    });
  });

  it("ships free from the threshold", () => {
    const totals = cartTotals(
      [
        { productId: "sku-tee", quantity: 2 },
        { productId: "sku-stickers", quantity: 2 },
      ],
      findProduct,
    );
    expect(totals.subtotalCents).toBe(5400);
    expect(totals.shippingCents).toBe(0);
    expect(totals.totalCents).toBe(5400);
  });

  it("fails loudly on unknown products", () => {
    expect(() => cartTotals([{ productId: "nope", quantity: 1 }], findProduct)).toThrow(
      /Unknown product/,
    );
  });
});

describe("formatPrice", () => {
  it("formats cents as US dollars", () => {
    expect(formatPrice(1400)).toBe("$14.00");
    expect(formatPrice(499)).toBe("$4.99");
  });
});
