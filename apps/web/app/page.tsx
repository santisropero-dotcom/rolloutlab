import { Storefront } from "../components/Storefront";

export default function HomePage() {
  return (
    <main>
      <header>
        <h1>RolloutLab sample storefront</h1>
        <p>A small shop used to try out flags and rollouts. All products and prices are synthetic.</p>
      </header>
      <Storefront />
    </main>
  );
}
