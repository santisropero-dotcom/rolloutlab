import type { FlagExplanation, ShopperContext } from "../lib/flags";

export interface FlagReasonPanelProps {
  explanation: FlagExplanation;
  shopper: ShopperContext;
  /** Problems found in the snapshot file; empty when it loaded cleanly. */
  problems: readonly string[];
}

const MAX_PROBLEMS_SHOWN = 5;

/**
 * Shows how the storefront resolved a flag for the current shopper, and lets
 * you switch to another synthetic shopper to see the decision change.
 */
export function FlagReasonPanel({ explanation, shopper, problems }: FlagReasonPanelProps) {
  return (
    <section aria-labelledby="flag-reason-heading" className="card flag-reason">
      <h2 id="flag-reason-heading">Why does this checkout look like this?</h2>
      <p>{explanation.summary}</p>

      <dl className="flag-details">
        <dt>Flag</dt>
        <dd>
          <code>{explanation.flagKey}</code>
        </dd>
        <dt>Value</dt>
        <dd>{explanation.value ? "on" : "off"}</dd>
        <dt>Reason</dt>
        <dd>
          <code>{explanation.reason}</code>
        </dd>
        {explanation.ruleId && (
          <>
            <dt>Rule</dt>
            <dd>
              <code>{explanation.ruleId}</code>
            </dd>
          </>
        )}
        {explanation.errorCode && (
          <>
            <dt>Error</dt>
            <dd>
              <code>{explanation.errorCode}</code>
            </dd>
          </>
        )}
        <dt>Environment</dt>
        <dd>{explanation.environment}</dd>
        <dt>Evaluated by</dt>
        <dd>Local OpenFeature provider (no network call)</dd>
      </dl>

      {problems.length > 0 && (
        <div role="alert" className="snapshot-problems">
          <p>The flag snapshot could not be used:</p>
          <ul>
            {problems.slice(0, MAX_PROBLEMS_SHOWN).map((problem, index) => (
              <li key={index}>{problem}</li>
            ))}
          </ul>
          {problems.length > MAX_PROBLEMS_SHOWN && (
            <p>…and {problems.length - MAX_PROBLEMS_SHOWN} more.</p>
          )}
        </div>
      )}

      <form method="get" className="shopper-form">
        <label>
          Shopper id
          <input name="shopper" defaultValue={shopper.targetingKey} maxLength={64} />
        </label>
        <label>
          Email (optional)
          <input name="email" type="email" defaultValue={shopper.email ?? ""} maxLength={254} />
        </label>
        <button type="submit">Evaluate as this shopper</button>
      </form>
      <p className="hint">
        Shoppers and emails are synthetic. Try <code>shopper-0013</code> (inside the 10% rollout) or
        an email ending in <code>@rolloutlab.test</code> (staff rule).
      </p>
    </section>
  );
}
