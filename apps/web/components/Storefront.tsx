"use client";

import { useState } from "react";
import { catalog, findProduct } from "../lib/catalog";
import { checkoutButtonLabel } from "../lib/checkout";
import {
  MAX_QUANTITY,
  addItem,
  cartTotals,
  formatPrice,
  removeItem,
  setQuantity,
  type Cart,
} from "../lib/cart";

export interface StorefrontProps {
  /** Value of the `new-checkout` flag, resolved on the server. */
  newCheckout: boolean;
}

export function Storefront({ newCheckout }: StorefrontProps) {
  const [cart, setCart] = useState<Cart>([]);
  const [orderPlaced, setOrderPlaced] = useState(false);
  const totals = cartTotals(cart, findProduct);

  function placeOrder() {
    setCart([]);
    setOrderPlaced(true);
  }

  return (
    <div className="storefront">
      <section aria-labelledby="products-heading">
        <h2 id="products-heading">Products</h2>
        <ul className="product-grid">
          {catalog.map((product) => (
            <li key={product.id} className="card">
              <h3>{product.name}</h3>
              <p>{product.description}</p>
              <p className="price">{formatPrice(product.priceCents)}</p>
              <button
                type="button"
                onClick={() => {
                  setOrderPlaced(false);
                  setCart((current) => addItem(current, product.id));
                }}
              >
                Add to cart
              </button>
            </li>
          ))}
        </ul>
      </section>

      <aside aria-labelledby="cart-heading" className="card cart">
        <h2 id="cart-heading">Cart</h2>
        {orderPlaced && <p role="status">Order placed (sample checkout, nothing is charged).</p>}
        {cart.length === 0 ? (
          <p>Your cart is empty.</p>
        ) : (
          <>
            <ul className="cart-lines">
              {cart.map((line) => {
                const product = findProduct(line.productId);
                if (!product) return null;
                return (
                  <li key={line.productId}>
                    <span>{product.name}</span>
                    <label>
                      <span className="visually-hidden">Quantity for {product.name}</span>
                      <input
                        type="number"
                        min={0}
                        max={MAX_QUANTITY}
                        value={line.quantity}
                        onChange={(event) => {
                          const quantity = Number.parseInt(event.target.value, 10);
                          setCart((current) =>
                            setQuantity(current, line.productId, Number.isNaN(quantity) ? 0 : quantity),
                          );
                        }}
                      />
                    </label>
                    <span>{formatPrice(product.priceCents * line.quantity)}</span>
                    <button
                      type="button"
                      onClick={() => setCart((current) => removeItem(current, line.productId))}
                    >
                      Remove
                    </button>
                  </li>
                );
              })}
            </ul>
            <dl className="totals">
              <dt>Subtotal</dt>
              <dd>{formatPrice(totals.subtotalCents)}</dd>
              <dt>Shipping</dt>
              <dd>{totals.shippingCents === 0 ? "Free" : formatPrice(totals.shippingCents)}</dd>
              <dt>Total</dt>
              <dd>{formatPrice(totals.totalCents)}</dd>
            </dl>
            <button type="button" className="primary" onClick={placeOrder}>
              {checkoutButtonLabel(totals, newCheckout)}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}
