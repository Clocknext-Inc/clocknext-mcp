import { z } from "zod";

/**
 * The paging args and text shared by the catalogue list tools (credits,
 * outcomes, units, plans, composites — SE-194).
 *
 * The list routes answer one cursor page at a time, newest first, with a
 * strict `active` filter. A request without `limit` gets the deprecated
 * unpaged answer until 2027-03-01 and a 50-item page after it, so the API
 * client always sends `limit`; the tools hand `nextCursor` to the agent so it
 * can read the next page.
 */

/** The `active` / `limit` / `cursor` args of a list tool. */
export function listPageArgs(plural: string, activeText: string) {
  return {
    active: z.boolean().optional().describe(activeText),
    limit: z
      .number()
      .int()
      .min(1)
      .max(200)
      .optional()
      .describe(`How many ${plural} on this page, 1–200. Default 50.`),
    cursor: z
      .string()
      .optional()
      .describe(
        "The `nextCursor` of the previous page, to read the next one. Send the same `active` as on that page. Leave it out for the first page.",
      ),
  };
}

/** The paging rule appended to every list tool's description. */
export function listPageRules(plural: string): string {
  return [
    `- Newest first (the most recently created ${plural} come first). One page per call: at most \`limit\` items (default 50, max 200), plus \`nextCursor\`.`,
    `- \`nextCursor\` not null = there are more ${plural}: call again with \`cursor\` set to it (and the same \`active\`). \`null\` = this is the last page.`,
    `- Before you conclude that a ${plural.replace(/s$/, "")} does not exist (or pick a name / agentKey as "unused"), read every page until \`nextCursor\` is null.`,
  ].join("\n");
}
