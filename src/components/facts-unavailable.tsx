import { FACTS_MIGRATION } from "@/lib/business/load";
import { Callout } from "./ui/feedback";

/** Shown when the database has no business facts table yet. */
export function FactsUnavailable() {
  return (
    <Callout
      tone="danger"
      title="Business facts are not available on this database"
    >
      The database this app is connected to does not have the business facts
      table yet (migration {FACTS_MIGRATION} has not been applied). Monitoring
      and technical SEO keep working; the business profile, coverage and
      business tasks stay off until the migration is applied.
    </Callout>
  );
}
