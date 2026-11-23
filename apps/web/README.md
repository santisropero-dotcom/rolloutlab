# @rolloutlab/web — sample storefront

A small Next.js shop used to try out flags and rollouts. Products, prices, shoppers and emails are synthetic.

## Flags

The page resolves `new-checkout` on every request through the local OpenFeature provider (`@rolloutlab/evaluator/openfeature`), so no network call is made per evaluation. Below the cart, a panel shows the value, the reason (`TARGETING_MATCH`, `SPLIT`, `DEFAULT`, `DISABLED`, `ERROR`), the deciding rule and the environment, in one plain sentence.

- **Snapshot:** `flags/development.json`, or the file in `ROLLOUTLAB_FLAG_SNAPSHOT`. It is re-read on each request, so edits apply on the next page load.
- **Shopper:** `?shopper=<id>&email=<email>` (or the form in the panel). Without a valid id the page uses `shopper-0001`; an invalid email is ignored.
- **Bundled rules:** emails ending in `@rolloutlab.test` get the new checkout (`internal-staff`); everyone else is in a 10% rollout (`ten-percent`). `shopper-0013` is inside it, `shopper-0001` is not.
- **Failures:** a missing, oversized or invalid snapshot keeps every flag at its default in code (off), and the panel lists the problems.
