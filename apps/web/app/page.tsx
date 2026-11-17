import { Storefront } from "../components/Storefront";
import { NEW_CHECKOUT, parseFlagOverrides, resolveBooleanFlag } from "../lib/flags";

// Read flag overrides on every request so changing the environment does not need a rebuild.
export const dynamic = "force-dynamic";

export default function HomePage() {
  const overrides = parseFlagOverrides(process.env.ROLLOUTLAB_FLAG_OVERRIDES);
  const newCheckout = resolveBooleanFlag(NEW_CHECKOUT, overrides).value;

  return (
    <main>
      <header>
        <h1>RolloutLab sample storefront</h1>
        <p>A small shop used to try out flags and rollouts. All products and prices are synthetic.</p>
      </header>
      <Storefront newCheckout={newCheckout} />
    </main>
  );
}
