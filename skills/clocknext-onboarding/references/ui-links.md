# Clocknext product deep-links (the "Manually in the Clocknext" path)

These are the links you hand the user when they choose **Manually in the Clocknext** instead
of **Set it up using AI**. Base URL: **https://payments.clocknext.com** (the MCP's
`CLOCKNEXT_BASE_URL`; the Clocknext product is the same app). When you give a link, also **say what to
enter** — a bare link isn't guidance. Always render as a real markdown link, e.g.
"[set the price here](https://payments.clocknext.com/settings/models)".

| To do this Manually in the Clocknext | Link | What Set it up using AI does |
| --- | --- | --- |
| Enable one named model or set its price | `{base}/settings/models` | `clocknext_add_model` for one named model |
| Create or price one named credit | `{base}/credits` | `clocknext_create_credit` for one named credit |
| Create or price one named outcome | `{base}/outcomes` | `clocknext_create_outcome` for one named outcome |
| Create or price one named unit | `{base}/units` | `clocknext_create_unit` for one named unit |
| Create or update one named plan | `{base}/plans` | `clocknext_create_plan`/`update_plan` for one named plan |
| Create one named test customer | `{base}/customers` | `clocknext_create_customer` for one named customer |

For **credits and outcomes**, the Manually in the Clocknext path is the richer one and worth
recommending: it shows a **live price preview** and **stores the full per-model pricing
bundle** on the entitlement, which the MCP path can't (the MCP stores only the final computed
price). Tell the user that reason when you recommend it — see `pricing-and-models.md`.

(Creation lives on these top-level management pages — e.g. the "New credit" form is on
`/credits`, the plan builder on `/plans`.) If `CLOCKNEXT_BASE_URL` is set to a non-production
workspace, substitute that host instead of `payments.clocknext.com`.

Note there is **no equivalent in the Clocknext product for recording or confirming unit *events*** — those
happen in the customer's product at runtime, and the MCP has no unit-usage tool. Confirm Unit
consumption through the product's supported Unit usage/event-count endpoint; do not rely on a
balance alone for ARREAR Units.
