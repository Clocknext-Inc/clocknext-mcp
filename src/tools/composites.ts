import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClocknextApi } from "../api";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * Composite catalogue tools — list, get, create, update and archive / unarchive
 * the bundles that are grouped under one tag and billed as a single thing.
 *
 * These live outside `catalogue.ts` because a composite's inputs don't fit
 * that factory: it takes the wrapped items as three id lists rather than one
 * nested object, and an update that changes one of those lists has to read
 * the other two back first (the API replaces the item set whole). There is no
 * delete on the public API — a composite is retired by archiving it.
 *
 * The money boundary an agent has to understand: creating a composite prices
 * it but charges nobody. An invoice is built from plan components, never from
 * a catalogue entry, so a composite only starts costing money when a plan
 * SELLS it. That second step is `clocknext_create_plan` with a `COMPOSITE`
 * line.
 */
export function registerCompositeTools(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_list_composites",
    {
      title: "Clocknext: list composites",
      description: [
        "List the organisation's composites — bundles of credits / outcomes / units grouped under one tag and billed as ONE thing. Returns each composite's `id` (what a plan's COMPOSITE line sends as compositeId) and `refId` (what the product's code puts in a signal's composite tag), plus the catalogue items it is restricted to, with their agentKeys.",
        "",
        "Rules:",
        "- Call this BEFORE tagging any signal with a composite: only a live composite's refId resolves, and a tag naming nothing is silently ignored rather than rejected — so a typo looks exactly like success.",
        "- Call it BEFORE clocknext_create_plan / clocknext_update_plan too: the `id` here is what a COMPOSITE line references as compositeId. `id` and `refId` are NOT interchangeable — the plan wants the id, the signal wants the refId.",
        "- A composite is restricted to a set of credits/outcomes/units. Only signals naming something in that set may carry its tag. Empty lists mean unrestricted (legacy rows only).",
        "- Pass active=true for only the ones a new signal can still be tagged with. Archived composites keep every row they already own.",
        "- To change one, use clocknext_update_composite; to retire one, clocknext_archive_composite. Never create a second composite as a workaround — the old one keeps resolving and both stay live.",
      ].join("\n"),
      inputSchema: {
        active: z
          .boolean()
          .optional()
          .describe(
            "true = only composites that still accept new traffic, false = only archived ones, omit = all.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ active }) => {
      try {
        const rows = await cnk.composites.list(active === undefined ? {} : { active });
        // The API only filters `active=true`; `active=false` comes back
        // unfiltered. Filter here, like the other list tools.
        const filtered =
          active === undefined
            ? rows
            : (rows as { isActive?: boolean }[]).filter((r) => r.isActive === active);
        return jsonResult({ count: filtered.length, composites: filtered });
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_create_composite",
    {
      title: "Clocknext: create composite",
      description: [
        "Create a composite — a bundle of credits / outcomes / units that is grouped under one tag and billed as ONE thing instead of per item. Use it when several metered steps together make up one sellable unit of work (a call, a job, a document).",
        "",
        "Rules:",
        "- `refId` is the integration contract: it is what the product's code sends as a signal's compositeRef. Saved and matched exactly as sent (case included); letters, digits, ., _ and - only. It may NOT collide with a field the ingest body already owns (customerId, usage, agentKey, runId, member, custom, composite, …) — a collision is refused here, not silently ignored later.",
        "- `entitlements` is REQUIRED — at least one credit / outcome / unit id. A composite restricted to nothing would accept every signal in the organisation. Get the ids from clocknext_list_credits / clocknext_list_outcomes / clocknext_list_units (ids, not agentKeys). Every item must be active, and a unit must be FLAT-priced.",
        "- `price` is what ONE occurrence costs once a plan sells this. Creating a composite CHARGES NOBODY: an invoice is built from plan components, never from a catalogue entry.",
        "- To actually bill it, add it to a plan with clocknext_create_plan / clocknext_update_plan as a line of type COMPOSITE, passing the id this tool returns as `compositeId`, plus a billingMode and, for ADVANCE, a quantity — that quantity is a prepaid pool of slots shared across the wrapped items. Tell the user this second step is required, or they will wonder why a composite they created bills nothing.",
        "- It can be changed later with clocknext_update_composite — but renaming `refId` cuts live traffic over at once (signals still sending the old tag go untagged, silently), so get refId right first time.",
        "- A name or refId already in use is refused (409).",
      ].join("\n"),
      inputSchema: {
        name: z
          .string()
          .min(1)
          .max(80)
          .describe("Human-readable name, e.g. 'Voice AI call'."),
        refId: z
          .string()
          .min(1)
          .max(80)
          .describe(
            "The tag identifier the product's code will send (e.g. 'voice_ai'). Saved and matched exactly as sent (case included); letters, digits, ., _ and - only; must not collide with a reserved ingest field.",
          ),
        price: z
          .number()
          .min(0)
          .describe(
            "USD charged per completed occurrence once a plan sells this composite. Ask the user — do not invent a price.",
          ),
        description: z
          .string()
          .max(400)
          .optional()
          .describe("Optional note about what this bundle represents."),
        creditIds: z
          .array(z.string())
          .optional()
          .describe("Credit ids to restrict this composite to (from clocknext_list_credits)."),
        outcomeIds: z
          .array(z.string())
          .optional()
          .describe("Outcome ids to restrict this composite to (from clocknext_list_outcomes)."),
        unitIds: z
          .array(z.string())
          .optional()
          .describe("Unit ids to restrict this composite to (from clocknext_list_units)."),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ name, refId, price, description, creditIds, outcomeIds, unitIds }) => {
      // Checked here rather than left to the server so the agent gets the
      // actionable message ("go list the catalogue") instead of a 400 whose
      // wording is aimed at the Clocknext product's picker.
      const total =
        (creditIds?.length ?? 0) + (outcomeIds?.length ?? 0) + (unitIds?.length ?? 0);
      if (total === 0) {
        return errorResult(
          "A composite must wrap at least one credit, outcome or unit. Call clocknext_list_credits / clocknext_list_outcomes / clocknext_list_units and pass the ids of the items this bundle is made of.",
        );
      }
      try {
        return jsonResult(
          await cnk.composites.create({
            name,
            refId,
            price,
            ...(description ? { description } : {}),
            entitlements: {
              ...(creditIds?.length ? { creditIds } : {}),
              ...(outcomeIds?.length ? { outcomeIds } : {}),
              ...(unitIds?.length ? { unitIds } : {}),
            },
          }),
        );
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_composite",
    {
      title: "Clocknext: get composite",
      description:
        "Get one composite in full by id — name, refId, price, description, active state, and the credits / outcomes / units it wraps (with their agentKeys).",
      inputSchema: { id: z.string().describe("The composite id (from clocknext_list_composites).") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.composites.get(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_update_composite",
    {
      title: "Clocknext: update composite",
      description: [
        "Update a composite by id.",
        "",
        "Rules:",
        "- Partial update: pass the id plus ONLY the fields to change; everything you leave out keeps its stored value.",
        "- creditIds / outcomeIds / unitIds: each list you pass is the complete new list for that kind; a kind you leave out keeps its current items. The composite must still wrap at least one item. Items it already wraps may stay even if since archived; a newly added one must be active (and a unit FLAT-priced).",
        "- Renaming `refId` cuts ingest over at once: signals still sending the old tag go untagged, silently. Ship the new tag in the product's code first, then rename.",
        "- A new `price` applies to purchases made after the change; existing purchases keep the price they were bought at.",
      ].join("\n"),
      inputSchema: {
        id: z.string().describe("The composite id to update."),
        name: z.string().min(1).max(80).optional().describe("New name."),
        refId: z.string().min(1).max(80).optional().describe("New tag identifier — see the rename rule."),
        price: z.number().min(0).optional().describe("New USD price per completed occurrence."),
        description: z.string().max(400).nullish().describe("New description (null clears it)."),
        creditIds: z.array(z.string()).optional().describe("Complete new list of wrapped credit ids."),
        outcomeIds: z.array(z.string()).optional().describe("Complete new list of wrapped outcome ids."),
        unitIds: z.array(z.string()).optional().describe("Complete new list of wrapped unit ids."),
      },
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id, name, refId, price, description, creditIds, outcomeIds, unitIds }) => {
      try {
        const body: Record<string, unknown> = {};
        if (name !== undefined) body.name = name;
        if (refId !== undefined) body.refId = refId;
        if (price !== undefined) body.price = price;
        if (description !== undefined) body.description = description;

        // The API replaces the wrapped-item set whole, so a list the agent
        // didn't pass is filled in from the composite as it is now.
        if (creditIds !== undefined || outcomeIds !== undefined || unitIds !== undefined) {
          const current = (await cnk.composites.get(id)) as {
            entitlements?: {
              credits?: { id: string }[];
              outcomes?: { id: string }[];
              units?: { id: string }[];
            };
          };
          const ids = (rows: { id: string }[] | undefined) => (rows ?? []).map((r) => r.id);
          body.entitlements = {
            creditIds: creditIds ?? ids(current.entitlements?.credits),
            outcomeIds: outcomeIds ?? ids(current.entitlements?.outcomes),
            unitIds: unitIds ?? ids(current.entitlements?.units),
          };
        }

        if (Object.keys(body).length === 0) {
          return errorResult("Nothing to update — pass the composite id plus at least one field to change.");
        }
        return jsonResult(await cnk.composites.update(id, body));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_archive_composite",
    {
      title: "Clocknext: archive composite",
      description: [
        "Archive a composite (isActive→false) — the API never deletes; this is how a composite is retired.",
        "",
        "Rules:",
        "- New signals stop resolving to it (a tag naming it is then ignored); every row it already owns keeps pointing at it, so its history stays intact.",
        "- Plans already selling it are unaffected — update those plans with clocknext_update_plan to stop selling it.",
        "- Reversible: reactivate with clocknext_unarchive_composite.",
      ].join("\n"),
      inputSchema: { id: z.string().describe("The composite id to archive.") },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.composites.setActive(id, false));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_unarchive_composite",
    {
      title: "Clocknext: unarchive composite",
      description:
        "Reactivate an archived composite (sets isActive→true) — the reverse of clocknext_archive_composite. Same refId, same wrapped items; its tag resolves again for new signals. Prefer this over creating a replacement.",
      inputSchema: { id: z.string().describe("The composite id to reactivate.") },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.composites.setActive(id, true));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}
