import type { Product } from "./catalog";

export interface CartLine {
  productId: string;
  quantity: number;
}

export type Cart = readonly CartLine[];

export interface CartTotals {
  itemCount: number;
  subtotalCents: number;
  shippingCents: number;
  totalCents: number;
}

export const MAX_QUANTITY = 10;
export const FLAT_SHIPPING_CENTS = 499;
export const FREE_SHIPPING_FROM_CENTS = 5000;

export function addItem(cart: Cart, productId: string): Cart {
  const existing = cart.find((line) => line.productId === productId);
  if (!existing) {
    return [...cart, { productId, quantity: 1 }];
  }
  return setQuantity(cart, productId, existing.quantity + 1);
}

/** Sets a line's quantity, clamped to MAX_QUANTITY. Zero or less removes the line. */
export function setQuantity(cart: Cart, productId: string, quantity: number): Cart {
  if (!Number.isInteger(quantity)) {
    throw new RangeError(`Quantity must be an integer, got ${quantity}`);
  }
  if (quantity <= 0) {
    return removeItem(cart, productId);
  }
  const clamped = Math.min(quantity, MAX_QUANTITY);
  return cart.map((line) =>
    line.productId === productId ? { ...line, quantity: clamped } : line,
  );
}

export function removeItem(cart: Cart, productId: string): Cart {
  return cart.filter((line) => line.productId !== productId);
}

export function cartTotals(
  cart: Cart,
  lookup: (id: string) => Product | undefined,
): CartTotals {
  let itemCount = 0;
  let subtotalCents = 0;
  for (const line of cart) {
    const product = lookup(line.productId);
    if (!product) {
      throw new Error(`Unknown product in cart: ${line.productId}`);
    }
    itemCount += line.quantity;
    subtotalCents += product.priceCents * line.quantity;
  }
  const shippingCents =
    itemCount === 0 || subtotalCents >= FREE_SHIPPING_FROM_CENTS ? 0 : FLAT_SHIPPING_CENTS;
  return { itemCount, subtotalCents, shippingCents, totalCents: subtotalCents + shippingCents };
}

export function formatPrice(cents: number): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
}
