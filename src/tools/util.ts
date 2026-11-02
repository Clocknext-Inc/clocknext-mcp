import { ClocknextError, FeatureLockedError } from "../api";

/** A successful tool result carrying a JSON payload as pretty text. */
export function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

/** An error tool result — surfaces the message to the agent, flagged isError. */
export function errorResult(message: string) {
  return {
    content: [{ type: "text" as const, text: message }],
    isError: true as const,
  };
}

/** Turn any thrown value into a helpful one-line message for the agent. */
export function errMsg(err: unknown): string {
  if (err instanceof ClocknextError) {
    // Include the subclass (AuthError, AllowanceError, RateLimitError, …) so
    // callers can branch on the kind, not just the shared status code.
    // A locked feature also names the feature, so the agent can tell the user
    // which part of their Clocknext plan to upgrade.
    const feature = err instanceof FeatureLockedError && err.feature ? ` [feature: ${err.feature}]` : "";
    return `Clocknext ${err.constructor.name}${err.status ? ` (${err.status})` : ""}: ${err.message}${feature}`;
  }
  return err instanceof Error ? err.message : String(err);
}
