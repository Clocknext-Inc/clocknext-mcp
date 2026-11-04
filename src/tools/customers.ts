import { z } from "zod";
import type { ClocknextApi } from "../api";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { errMsg, errorResult, jsonResult } from "./util";

/**
 * Customer tools — create/read customers, subscribe them to a plan (purchase),
 * read a customer's balances / current plan, and a bulk import. They go
 * through the MCP's own API client (`src/api.ts`). They power the
 * clocknext-setup-billing skill's "dummy customer + test signal + confirm it landed"
 * step and the clocknext-customer-mapping / bulk-import skills.
 */

// Shared customer profile fields. `name` + `email` are required on create.
const customerFields = {
  name: z.string().min(1).describe("Customer / company name."),
  email: z
    .string()
    .min(1)
    .describe("Primary email — required, and the key bulk import matches back on."),
  description: z.string().nullish().describe("Optional freeform description of the customer."),
  website: z.string().nullish().describe("The customer's website."),
  phone: z.string().nullish().describe("Contact phone number."),
  legalName: z.string().nullish().describe("Registered legal name (for invoices), when it differs from `name`."),
  addressLine1: z.string().nullish().describe("Billing address, line 1."),
  addressLine2: z.string().nullish().describe("Billing address, line 2."),
  city: z.string().nullish().describe("Billing address city."),
  state: z.string().nullish().describe("Billing address state / province / region."),
  country: z.string().nullish().describe("Billing address country."),
  pincode: z.string().nullish().describe("Postal / ZIP / PIN code."),
  taxId: z.string().nullish().describe("Tax identifier shown on invoices (VAT / GST / EIN…)."),
  notes: z.string().nullish().describe("Internal notes about the customer."),
  logoUrl: z.string().nullish().describe("URL of the customer's logo image."),
  currencyCode: z
    .string()
    .optional()
    .describe("ISO 4217 (3 letters); must be enabled for the org. Defaults to the org currency."),
} satisfies z.ZodRawShape;

const customerObject = z.object(customerFields);

export function registerCustomerTools(server: McpServer, cnk: ClocknextApi): void {
  server.registerTool(
    "clocknext_create_customer",
    {
      title: "Clocknext: create customer",
      description: [
        "Create a Clocknext customer — the entity you bill (maps to one of your end-users / tenants / organisations).",
        "",
        "Rules:",
        "- `name` and `email` are required; everything else is optional profile.",
        "- Returns the customer `id` — pass it as `customerId` to clocknext_create_purchase and to the signals your product code sends.",
      ].join("\n"),
      inputSchema: customerFields,
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await cnk.customers.create(args));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_customer",
    {
      title: "Clocknext: get customer",
      description: "Fetch one customer by Clocknext id.",
      inputSchema: { id: z.string().describe("The Clocknext customer id.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.customers.get(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_list_customers",
    {
      title: "Clocknext: list customers",
      description:
        "List / search the org's customers, most-recent first (cursor-paginated). Use it to find a customer id or check whether one already exists before creating.",
      inputSchema: {
        q: z.string().optional().describe("Search by name or email."),
        limit: z.number().int().min(1).max(100).optional().describe("Max customers per page."),
        cursor: z.string().optional().describe("Pagination cursor from a previous page's nextCursor."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await cnk.customers.list(args));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_customer_balances",
    {
      title: "Clocknext: get customer balances",
      description:
        "Fetch a customer's current wallet / credit / outcome / unit balances. Use it to confirm a purchase granted the expected entitlements, or that a test signal drew the balance down as expected.",
      inputSchema: { id: z.string().describe("The Clocknext customer id.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.customers.balances(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_get_customer_plan",
    {
      title: "Clocknext: get customer plan",
      description:
        "Fetch a customer's current active plan (from their purchase). Use it to confirm a customer is subscribed to the plan you expect before firing a test signal.",
      inputSchema: { id: z.string().describe("The Clocknext customer id.") },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ id }) => {
      try {
        return jsonResult(await cnk.customers.plan(id));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_create_purchase",
    {
      title: "Clocknext: subscribe customer to a plan",
      description: [
        "Subscribe a customer to a plan (a 'purchase') — this activates the plan for that customer. Used to wire up a dummy customer before firing test signals.",
        "",
        "Rules:",
        "- ⛔ Raises a REAL invoice (real money on a live org). Only call this after the user explicitly approved this purchase in a question dedicated to it alone — never bundled with another question, never inferred from an earlier yes.",
        "- ⛔ If the customer already has a scheduled/active purchase, the new one AUTO-CANCELS it when it activates (old status→CANCELLED, its open invoices voided, credit balances reset — this is how 'change plan' works). Check clocknext_get_customer_plan first and SAY SO in the approval question.",
        "- Do this after clocknext_create_customer + clocknext_create_plan.",
        "- A usage signal only prices if the customer has an active plan whose components match the meter (credit / outcome / unit).",
      ].join("\n"),
      inputSchema: {
        customerId: z
          .string()
          .describe("Clocknext customer id (from clocknext_create_customer / _list_customers)."),
        planId: z.string().describe("Plan id (from clocknext_create_plan / _list_plans)."),
        billingDate: z
          .string()
          .optional()
          .describe("YYYY-MM-DD. Default today; must be a valid, non-past date."),
        notes: z.string().optional().describe("Internal notes for this purchase."),
        autoPayment: z.boolean().optional().describe("Charge automatically when the invoice is due."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async (args) => {
      try {
        return jsonResult(await cnk.purchases.create(args));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );

  server.registerTool(
    "clocknext_bulk_import_customers",
    {
      title: "Clocknext: bulk import customers",
      description: [
        "Bulk-create Clocknext customers in ONE request — for backfilling an existing user base. Returns a PER-ROW result (created id, or an error) so one duplicate/bad row never aborts the batch.",
        "",
        "Rules:",
        "- Each customer needs name + email; up to 200 per call. For a larger base, call again in ≤200-row chunks.",
        "- Match results back to your users by email.",
        "- MCP-only bulk endpoint (no SDK / public API).",
      ].join("\n"),
      inputSchema: {
        customers: z
          .array(customerObject)
          .min(1)
          .max(200)
          .describe("Customers to create; name + email required each; ≤200 per call."),
      },
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ customers }) => {
      try {
        return jsonResult(await cnk.customers.bulkCreate(customers));
      } catch (err) {
        return errorResult(errMsg(err));
      }
    },
  );
}
