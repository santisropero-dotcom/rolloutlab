import { formatPrice, type CartTotals } from "./cart";

/** Label for the checkout button. The new checkout shows the amount up front. */
export function checkoutButtonLabel(totals: CartTotals, newCheckout: boolean): string {
  if (newCheckout) {
    return `Pay ${formatPrice(totals.totalCents)} now`;
  }
  const noun = totals.itemCount === 1 ? "item" : "items";
  return `Checkout (${totals.itemCount} ${noun})`;
}
