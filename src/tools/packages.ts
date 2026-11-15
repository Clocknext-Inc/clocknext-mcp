import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClocknextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * Package tools — the package catalog (list, get, create, update, archive,
 * unarchive) and the packages on a subscription (read, add, remove).
 *
 * A package is one or more entitlements and one price, added to a customer's
 * subscription on top of its plan: a top-up or an add-on. It renews with the
 * subscription on the plan's billing cycle until it is removed, and it is
 * always paid in advance. It has no billing cycle, billing mode or rollover of
 * its own, never holds a wallet, and holds one flat fee at most. Each of its
 * entitlements (except a flat fee) must be on the customer's plan as advance,
 * or the attach is refused.
 *
 * These live outside the `catalogue.ts` factory because a package's lines have
 * no billing mode, and the subscription routes are not catalogue routes.
 */

const ENTITLEMENT_TYPES = ["CREDIT", "OUTCOME", "UNIT", "COMPOSITE", "FLAT"] as const;

const RECORDED_PAYMENT_MODES = [
  "CASH",
  "BANK_TRANSFER",
  "WIRE_TRANSFER",
  "CARD",
  "CHEQUE",
  "UPI",
  "OTHER",
] as const;

const packageEntitlement = z.object({
  id: z
    .string()
    .optional()
    .describe(
      "Update only: the id of an entitlement the package already holds (from clocknext_get_package). Send it back to keep that entitlement; leave it out for a new one.",
    ),
  type: z
    .enum(ENTITLEMENT_TYPES)
    .describe(
      "CREDIT / OUTCOME / UNIT / COMPOSITE (with its id and a quantity) or FLAT (a fee, with an amount). There is no WALLET: a package never holds a wallet.",
    ),
  creditId: z.string().optional().describe("CREDIT: the credit id (from clocknext_list_credits)."),
  outcomeId: z.string().optional().describe("OUTCOME: the outcome id (from clocknext_list_outcomes)."),
  unitId: z.string().optional().describe("UNIT: the unit id (from clocknext_list_units)."),
  compositeId: z.string().optional().describe("COMPOSITE: the composite id (from clocknext_list_composites)."),
  quantity: z
    .number()
    .int()
    .positive()
    .optional()
    .describe("CREDIT / OUTCOME / UNIT / COMPOSITE: how many the package grants each cycle — a whole number above 0."),
  amount: z.number().min(0).optional().describe("FLAT only: the fee in USD. One flat fee per package at most."),
});

const PACKAGE_RULES = [
  "- A package is one or more entitlements and one price, added to a customer's subscription ON TOP of its plan — a top-up or an add-on (\"500 extra AI credits for $4\"). It renews with the subscription on the plan's billing cycle until it is removed, and it is always paid in advance.",
  "- It has NO billing cycle, billing mode or rollover of its own (it follows the plan), it NEVER holds a wallet (extra wallet money belongs in the Reserved wallet), and it holds one flat fee at most. Sending any of those is a 400.",
  "- Each entitlement except a flat fee must ALSO be on the customer's plan as ADVANCE (billed up-front, not metered). The catalog accepts any active entitlement, but adding the package to a subscription whose plan lacks it, or meters it, is refused (PACKAGE_ENTITLEMENT_NOT_ON_PLAN / PACKAGE_ENTITLEMENT_METERED). Check the target plan with clocknext_get_plan first.",
  "- The same entitlement can't be listed twice. Every entitlement must be active and belong to this organisation.",
].join("\n");

export function registerPackageTools(server: McpServer, cnk: ClocknextApi): void {
  // ---------- catalog ----------

  server.registerTool(
    "clocknext_list_packages",
    {
      title: "Clocknext: list packages",
      description: [
        "List the organisation's packages, oldest first — each with its id, name, price (`subtotalUsd`), active state and entitlements.",
        "",
        "Rules:",
        "- A package is a top-up or add-on that a customer's subscription gets on top of its plan. Its `id` is what clocknext_add_subscription_packages takes.",
        "- Pass active=true for only the ones that can still be added to a subscription. Archived packages stay on the subscriptions that already have them.",
        "- Call this before creating one: a taken name is refused (409). To change one, use clocknext_update_package.",
      ].join("\n"),
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe("true = only packages that can be added, false = only archived ones, omit = all."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ active }) => {
      try {
        const rows = await cnk.packages.list(active === undefined ? {} : { active });
        // The API only filters `active=true`; `active=false` comes back
        // unfiltered. Filter here, like the other list tools.
        const filtered =
          active === undefined
            ? rows
            : (rows as { isActive?: boolean }[]).filter((r) => r.isActive === active);
        return jsonResult({ count: filtered.length, packages: filtered });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_package",
    {
      title: "Clocknext: get package",
      description:
        "Get one package by id — name, description, price (`subtotalUsd`, and `priceAdjustmentUsd` = the price less the entitlements' list prices), active state, and its entitlements with their ids.",
      inputSchema: { id: z.string().describe("The package id (from clocknext_list_packages).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.packages.get(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_create_package",
    {
      title: "Clocknext: create package",
      description: [
        "Create a package — a top-up or add-on that can be added to a customer's subscription on top of its plan.",
        "",
        "Rules:",
        PACKAGE_RULES,
        "- `subtotalUsd` is the package price each billing cycle of the plan. Leave it out to charge the sum of the entitlements' list prices. Ask the user for the price — do not invent one.",
        "- Creating a package CHARGES NOBODY. A customer pays for it only when it is added to their subscription with clocknext_add_subscription_packages.",
        "- A name already in use is refused (409). There is no delete: retire a package with clocknext_archive_package.",
      ].join("\n"),
      inputSchema: {
        name: z.string().min(1).describe("Package name, e.g. 'Booster'. Unique in the organisation."),
        description: z.string().optional().describe("Optional description."),
        subtotalUsd: z
          .number()
          .min(0)
          .optional()
          .describe("The package price in USD, before tax, each billing cycle. Default: the entitlements' list prices."),
        entitlements: z
          .array(packageEntitlement)
          .min(1)
          .describe("At least one entitlement. CREDIT / OUTCOME / UNIT / COMPOSITE need their id and a quantity; FLAT needs an amount."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async (args) => {
      try {
        return jsonResult(await cnk.packages.create(definedOnly(args)));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_update_package",
    {
      title: "Clocknext: update package",
      description: [
        "Update a package by id.",
        "",
        "Rules:",
        "- Partial update: pass the id plus ONLY the fields to change; everything you leave out keeps its stored value.",
        "- `entitlements`, when passed, is the COMPLETE new list. Send each entitlement you keep with its `id` (from clocknext_get_package); one left out is removed.",
        "- Without `subtotalUsd`, a new entitlements list resets the price to the sum of their list prices. An update without entitlements keeps the price.",
        PACKAGE_RULES,
        "- An edit changes nothing for customers who already have the package: their subscription keeps its own copy.",
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("The package id to update."),
        name: z.string().min(1).optional().describe("New name."),
        description: z.string().nullish().describe("New description (null clears it)."),
        subtotalUsd: z.number().min(0).optional().describe("New price in USD, before tax."),
        entitlements: z
          .array(packageEntitlement)
          .min(1)
          .optional()
          .describe("The complete new list of entitlements; send each kept one's id back."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, ...fields }) => {
      const body = definedOnly(fields);
      if (Object.keys(body).length === 0) {
        return errorResult("Nothing to update — pass the package id plus at least one field to change.");
      }
      try {
        return jsonResult(await cnk.packages.update(id, body));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_archive_package",
    {
      title: "Clocknext: archive package",
      description: [
        "Archive a package (isActive→false) — the API never deletes; this is how a package is retired.",
        "",
        "Rules:",
        "- It can't be added to a subscription any more (PACKAGE_ARCHIVED). Customers who already have it keep their copy, and it keeps renewing for them.",
        "- To take it off a customer, use clocknext_remove_subscription_package.",
        "- Reversible: reactivate with clocknext_unarchive_package.",
      ].join("\n"),
      inputSchema: { id: z.string().describe("The package id to archive.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.packages.setActive(id, false));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_unarchive_package",
    {
      title: "Clocknext: unarchive package",
      description:
        "Reactivate an archived package (isActive→true) — the reverse of clocknext_archive_package. It can be added to subscriptions again. Prefer this over creating a replacement.",
      inputSchema: { id: z.string().describe("The package id to reactivate.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.packages.setActive(id, true));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  // ---------- on a subscription ----------

  server.registerTool(
    "clocknext_get_subscription",
    {
      title: "Clocknext: get subscription",
      description: [
        "Get one subscription by id — the period running now, with its `packages` and `periods[]` (the periods it renewed out of).",
        "",
        "Rules:",
        "- The subscription id is the purchase id: `plan.purchaseId` from clocknext_get_customer_plan, or the id clocknext_create_purchase returned.",
        "- `packages` lists the packages that are AWAITING_PAYMENT, ACTIVE or ENDING, oldest first; ended ones are left out. Each one's `id` is the purchasePackageId that clocknext_remove_subscription_package takes.",
      ].join("\n"),
      inputSchema: { id: z.string().describe("The subscription id (= the purchase id).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.subscriptions.get(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_add_subscription_packages",
    {
      title: "Clocknext: add packages to a subscription",
      description: [
        "Add one or more packages to a customer's subscription. Raises ONE invoice, one line per package, at the full package price.",
        "",
        "Rules:",
        "- ⛔ Raises a REAL invoice (real money on a live org). Only call this after the user explicitly approved this exact attach — which packages, on which customer's subscription, for how much — in a question dedicated to it alone.",
        "- The packages are AWAITING_PAYMENT until the invoice is paid (the result has its `payUrl`), then ACTIVE. With `recordAsPaid` the invoice is recorded as paid (paid outside Clocknext) and they are ACTIVE at once — only when the user says it was really paid.",
        "- Each package entitlement (except a flat fee) must be on the subscription's plan as ADVANCE. Check with clocknext_get_customer_plan / clocknext_get_plan before calling.",
        "- Pass an `idempotencyKey` and reuse it if you retry after a timeout or network error: the same key with the same packages answers with the first attach (`replayed: true`) and writes nothing, so a retry never bills twice.",
        "- Returns `purchasePackages` (in the order sent; each `id` is what clocknext_remove_subscription_package takes), `invoice` and `replayed`.",
        "",
        "Refusals (`code` in the error):",
        "- INVALID_REQUEST (400): a bad body.",
        "- SUBSCRIPTION_NOT_FOUND (404): no such subscription in this organisation.",
        "- PACKAGE_NOT_FOUND (404): no such package in this organisation.",
        "- SUBSCRIPTION_NOT_ACTIVE (409): the subscription is on hold, marked for cancellation, cancelled, or on a free plan.",
        "- PACKAGE_ARCHIVED (409): a package is archived — unarchive it with clocknext_unarchive_package, or pick another.",
        "- PACKAGE_ENTITLEMENT_NOT_ON_PLAN (409): the plan doesn't have one of the package's entitlements as advance — add it to the plan (clocknext_update_plan) or change the package.",
        "- PACKAGE_ENTITLEMENT_METERED (409): the plan meters (ARREAR) one of the package's entitlements — a package can only top up an advance entitlement.",
        "- IDEMPOTENCY_KEY_REUSED (422): the key was used for another attach (other packages or another subscription) — use a new key.",
      ].join("\n"),
      inputSchema: {
        subscriptionId: z
          .string()
          .describe("The subscription id (= the purchase id, `plan.purchaseId` from clocknext_get_customer_plan)."),
        packageIds: z
          .array(z.string().min(1))
          .min(1)
          .max(10)
          .refine((ids) => new Set(ids).size === ids.length, { message: "Each package id can be sent once." })
          .describe("1–10 package ids (from clocknext_list_packages), each once."),
        recordAsPaid: z
          .object({
            mode: z.enum(RECORDED_PAYMENT_MODES).describe("How the customer paid outside Clocknext."),
            reference: z.string().max(200).optional().describe("Optional payment reference, at most 200 characters."),
          })
          .optional()
          .describe("Record the invoice as already paid, so the packages start now. Only when the user says it was really paid."),
        idempotencyKey: z
          .string()
          .min(1)
          .max(255)
          .optional()
          .describe("1–255 characters. Reuse the same key on a retry so the attach is never made twice."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ subscriptionId, packageIds, recordAsPaid, idempotencyKey }) => {
      try {
        return jsonResult(
          await cnk.subscriptions.addPackages(subscriptionId, {
            packageIds,
            ...(recordAsPaid ? { recordAsPaid } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_remove_subscription_package",
    {
      title: "Clocknext: remove a package from a subscription",
      description: [
        "Remove a package from a customer's subscription, like cancelling a subscription.",
        "",
        "Rules:",
        "- By default it ends NOW (`endedReason: REMOVED`): what is left of the package is taken back (its amount less what was used — the package is used first). Nothing is refunded.",
        "- `atPeriodEnd: true` ends it at the end of the paid period instead: it is ENDING until `endsAt`, and keeps working until then. An ENDING package removed without atPeriodEnd ends now.",
        "- On a subscription on hold it ends now either way, and its line comes off the unpaid renewal invoice (same number and pay link); `invoice` in the result is that renewal. Otherwise `invoice` is null.",
        "- Ask the user which they want before calling: removing now takes back what the customer has not used yet.",
        "- The purchasePackageId is the `id` of an entry in the subscription's `packages` (clocknext_get_subscription), not the catalog package id.",
        "",
        "Refusals (`code` in the error):",
        "- INVALID_REQUEST (400): a bad body.",
        "- PACKAGE_NOT_FOUND (404): no such package on this subscription.",
        "- PACKAGE_ENDED (409): it has already ended.",
        "- PACKAGE_AWAITING_PAYMENT (409): it is not paid yet — void its invoice instead (in the Clocknext product).",
        "- PACKAGE_ALREADY_ENDING (409): atPeriodEnd: true on a package that is already ENDING.",
        "- RENEWAL_PAID_IN_PART (409): on hold, and part of the held renewal is already paid.",
        "- CHARGE_IN_FLIGHT (409): on hold, and a card charge on the renewal is settling — retry in a few minutes.",
        "- USAGE_UNAVAILABLE (409): removing now, but the usage can't be read right now — retry in a minute.",
      ].join("\n"),
      inputSchema: {
        subscriptionId: z.string().describe("The subscription id (= the purchase id)."),
        purchasePackageId: z
          .string()
          .describe("The package's id on the subscription (from clocknext_get_subscription `packages[].id`)."),
        atPeriodEnd: z
          .boolean()
          .optional()
          .describe("true = end at the end of the paid period. Omit (or false) = end now."),
        reason: z.string().max(200).optional().describe("Optional reason, at most 200 characters; kept as `removalReason`."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ subscriptionId, purchasePackageId, atPeriodEnd, reason }) => {
      try {
        return jsonResult(
          await cnk.subscriptions.removePackage(subscriptionId, purchasePackageId, {
            ...(atPeriodEnd !== undefined ? { atPeriodEnd } : {}),
            ...(reason !== undefined ? { reason } : {}),
          }),
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}

/** The arguments the agent actually sent — `undefined` fields dropped, so a
 *  left-out field is left out of the body too. */
function definedOnly(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
