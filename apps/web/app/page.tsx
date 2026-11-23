import { FlagReasonPanel } from "../components/FlagReasonPanel";
import { Storefront } from "../components/Storefront";
import { loadStorefrontFlags } from "../lib/flag-client";
import { NEW_CHECKOUT, explainEvaluation, shopperContext } from "../lib/flags";

// Evaluate on every request: the result depends on the shopper and the snapshot file.
export const dynamic = "force-dynamic";

interface HomePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function HomePage({ searchParams }: HomePageProps) {
  const shopper = shopperContext(await searchParams);
  const { client, load } = await loadStorefrontFlags();
  const details = await client.getBooleanDetails(
    NEW_CHECKOUT.key,
    NEW_CHECKOUT.defaultValue,
    { ...shopper },
  );
  const explanation = explainEvaluation(
    details,
    load.snapshot.flags.find((flag) => flag.key === NEW_CHECKOUT.key),
    load.snapshot.environment,
  );

  return (
    <main>
      <header>
        <h1>RolloutLab sample storefront</h1>
        <p>A small shop used to try out flags and rollouts. All products and prices are synthetic.</p>
      </header>
      <Storefront newCheckout={explanation.value} />
      <FlagReasonPanel explanation={explanation} shopper={shopper} problems={load.problems} />
    </main>
  );
}
