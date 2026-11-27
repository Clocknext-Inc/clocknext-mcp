import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClocknextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * Credit rule tools (SE-562) — list, get, create and update the rules that
 * change the price of a credit's signals. The public API has no delete: a rule
 * is turned off with `isActive: false`.
 *
 * A credit's rules run in `priority` order (1 first); the first active rule
 * whose conditions match a signal sets its price — a margin (MARGIN) or a fixed
 * number of credits per signal (CREDIT). The credit is named by its id.
 */

const creditId = z
  .string()
  .min(1)
  .describe("The credit's id (from clocknext_list_credits) — not its agentKey.");

const condition = z.object({
  fieldPath: z
    .string()
    .min(1)
    .describe(
      [
        "The signal field the condition reads:",
        "modelName — the model; `value` is an enabled model id from clocknext_list_models (e.g. 'gpt-4o'), never a display name.",
        "status — SUCCESS, FAILURE or PENDING.",
        "inputTokens / outputTokens / cacheTokens / totalTokens — numbers.",
        "providedCost — what the call cost at the provider, in USD.",
        "customerId — a customer id of this workspace (archived customers are allowed).",
        "custom.<key> — a key of the signal's `custom` object; needs valueType.",
      ].join(" "),
    ),
  operator: z
    .enum(["EQ", "NEQ", "GT", "GTE", "LT", "LTE", "CONTAINS", "STARTS_WITH", "ENDS_WITH"])
    .describe("How the signal's value is compared with `value`."),
  valueType: z
    .enum(["STRING", "NUMBER", "BOOLEAN"])
    .optional()
    .describe("Required for a custom.<key> field only; a built-in field knows its type."),
  value: z.string().min(1).describe("Always a string, also for a number ('10000')."),
  joiner: z
    .enum(["AND", "OR"])
    .nullable()
    .optional()
    .describe("Joins this condition to the one before it. Ignored on the first. Default AND."),
});

const ruleFields = {
  name: z.string().min(1).max(120).describe("Rule name, 1–120 characters."),
  description: z.string().max(500).nullable().optional().describe("Up to 500 characters; null clears it."),
  mode: z
    .enum(["MARGIN", "CREDIT"])
    .describe("MARGIN: the matching signal is priced with marginPercent. CREDIT: it costs creditsValue credits."),
  marginPercent: z
    .number()
    .nullable()
    .optional()
    .describe("MARGIN only (required there): the margin in percent, -100 or more."),
  creditsValue: z
    .number()
    .nullable()
    .optional()
    .describe("CREDIT only (required there): the credits charged per matching signal, 0 or more."),
  isActive: z.boolean().optional().describe("Default true. false turns the rule off without deleting it."),
  priority: z
    .number()
    .int()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "1 runs first. A number puts the rule there and the rules from there on move down one (they come back in `moved`). Left out, null or past the end: last.",
    ),
  conditions: z
    .array(condition)
    .min(1)
    .describe("At least one. The same conditions as another rule of the credit are refused (409)."),
};

/** Drops the fields left out; keeps `null`, which the API reads as "clear" or "keep the place". */
function sentOnly(args: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined));
}

export function registerCreditRuleTools(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_list_credit_rules",
    {
      title: "Clocknext: list credit rules",
      description: [
        "List a credit's rules in priority order (1 runs first). Each rule has its conditions, its mode (MARGIN with marginPercent, or CREDIT with creditsValue) and isActive.",
        "",
        "Rules:",
        "- The first ACTIVE rule whose conditions match a signal sets that signal's price; a signal no rule matches is priced by the credit itself.",
        "- A modelName condition reads back as the model id; when no enabled model has the stored name any more, the stored name comes back.",
        "- Needs the Credit rules feature; a locked feature is a 403 naming CREDIT_RULES.",
      ].join("\n"),
      inputSchema: { creditId },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ creditId: id }) => {
      try {
        const rules = await cnk.creditRules.list(id);
        return jsonResult({ count: rules.length, rules });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_credit_rule",
    {
      title: "Clocknext: get credit rule",
      description: "One rule of a credit, with its conditions and priority (1 runs first).",
      inputSchema: { creditId, ruleId: z.string().min(1).describe("The rule's id (from clocknext_list_credit_rules).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ creditId: id, ruleId }) => {
      try {
        return jsonResult(await cnk.creditRules.get(id, ruleId));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_create_credit_rule",
    {
      title: "Clocknext: create credit rule",
      description: [
        "Create a rule that changes the price of a credit's signals when they match its conditions — e.g. a higher margin for gpt-4o, or a fixed 5 credits for prompts over 10,000 input tokens.",
        "",
        "Rules:",
        "- priority: 1 runs first. A number inserts the rule there and moves the rules from there on down one; left out puts it last. The answer has the new rule and `moved` (the other rules whose priority changed).",
        "- A modelName condition takes an enabled model id from clocknext_list_models (e.g. 'gpt-4o'); an unknown or archived model is refused (400).",
        "- A customerId condition takes a customer id of this workspace.",
        "- A custom.<key> condition needs valueType (STRING, NUMBER or BOOLEAN); a built-in field does not.",
        "- Conditions are joined by each one's joiner (AND by default).",
        "- The same conditions as another rule of the credit are refused (409 CREDIT_RULE_DUPLICATE): change that rule with clocknext_update_credit_rule instead.",
        "- It takes effect on the next signal. Tell the user which signals it reprices.",
      ].join("\n"),
      inputSchema: { creditId, ...ruleFields },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        const { creditId: id, ...rest } = args as { creditId: string } & Record<string, unknown>;
        return jsonResult(await cnk.creditRules.create(id, sentOnly(rest)));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_update_credit_rule",
    {
      title: "Clocknext: update credit rule",
      description: [
        "Change a credit rule. PARTIAL: only the fields sent change.",
        "",
        "Rules:",
        "- `conditions`, if sent, replaces the whole list: re-send every condition you want to keep (read them with clocknext_get_credit_rule).",
        "- priority: a number moves the rule there and the rules in between shift one place; null or left out keeps its place. The answer has the rule and `moved` (the other rules whose priority changed).",
        "- isActive: false turns the rule off, true turns it back on. There is no delete.",
        "- Switching mode needs the new mode's value (marginPercent for MARGIN, creditsValue for CREDIT).",
      ].join("\n"),
      inputSchema: {
        creditId,
        ruleId: z.string().min(1).describe("The rule's id (from clocknext_list_credit_rules)."),
        name: ruleFields.name.optional(),
        description: ruleFields.description,
        mode: ruleFields.mode.optional(),
        marginPercent: ruleFields.marginPercent,
        creditsValue: ruleFields.creditsValue,
        isActive: ruleFields.isActive,
        priority: ruleFields.priority.describe(
          "1 runs first. A number moves the rule there; null or left out keeps its place.",
        ),
        conditions: ruleFields.conditions.optional(),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const { creditId: id, ruleId, ...rest } = args as { creditId: string; ruleId: string } & Record<string, unknown>;
        const payload = sentOnly(rest);
        if (Object.keys(payload).length === 0) {
          return errorResult("Nothing to update — pass the creditId, the ruleId and at least one field to change.");
        }
        return jsonResult(await cnk.creditRules.update(id, ruleId, payload));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}
