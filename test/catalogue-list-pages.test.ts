/**
 * REGRESSION — SE-194: the catalogue list tools read cursor pages.
 *
 * `GET /api/v1/{credits,outcomes,units,composites,plans}` now answer one page
 * at a time, newest first, with a strict `active` filter and a `nextCursor`.
 * A request that sends neither `limit` nor `cursor` gets the old answer until
 * the Sunset date (2027-03-01) and a 50-item page after it — so a tool that
 * sent no `limit` would silently start missing items. Every list call must
 * therefore send `limit`, and a list tool must hand the agent `nextCursor`.
 *
 * Needs no server: it registers the tools on a stand-in server, stubs
 * `fetch`, and reads back the requests the tools send.
 *
 *   npx tsx test/catalogue-list-pages.test.ts
 */
import { z } from "zod";
import { ClocknextApi } from "../src/api";
import { registerCatalogueTools } from "../src/tools/catalogue";
import { registerCompositeTools } from "../src/tools/composites";

type Handler = (args: Record<string, unknown>) => Promise<{
  content: { type: string; text: string }[];
  isError?: boolean;
}>;
type Tool = { config: { description?: string; inputSchema?: z.ZodRawShape }; handler: Handler };

const tools = new Map<string, Tool>();
const fakeServer = {
  registerTool(name: string, config: Tool["config"], handler: Handler) {
    tools.set(name, { config, handler });
  },
};

// --- fetch stub: records each request URL, answers with a fixed reply -------
const sent: URL[] = [];
let reply: unknown = {};

globalThis.fetch = (async (input: string | URL) => {
  sent.push(new URL(String(input)));
  return new Response(
    JSON.stringify({ statusCode: 200, statusDetail: { status: "SUCCESS", message: "ok" }, result: reply }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}) as typeof fetch;

const cnk = new ClocknextApi({ apiKey: "cnk_test", baseUrl: "http://localhost:0" });
registerCatalogueTools(fakeServer as never, cnk);
registerCompositeTools(fakeServer as never, cnk);

let failures = 0;
function check(label: string, cond: boolean, detail = ""): void {
  if (!cond) failures += 1;
  console.log(`  [${cond ? "PASS" : "FAIL"}] ${label}${cond ? "" : `  <-- ${detail}`}`);
}

function tool(name: string): Tool {
  const found = tools.get(name);
  if (!found) throw new Error(`${name} is not registered`);
  return found;
}

function parses(name: string, args: Record<string, unknown>): boolean {
  return z.object(tool(name).config.inputSchema ?? {}).safeParse(args).success;
}

/** Parse the args the way the MCP SDK does, run the handler, return the
 *  request it sent and the JSON it returned. */
async function call(name: string, args: Record<string, unknown>) {
  const t = tool(name);
  const parsed = z.object(t.config.inputSchema ?? {}).safeParse(args);
  if (!parsed.success) {
    throw new Error(`${name} refused ${JSON.stringify(args)}: ${parsed.error.message}`);
  }
  sent.length = 0;
  const result = await t.handler(parsed.data);
  const text = result.content[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text);
  } catch {
    // an error text — left as {}
  }
  return { url: sent[sent.length - 1], requests: sent.length, data, text, isError: result.isError === true };
}

const LISTS = [
  { plural: "credits", path: "/api/v1/credits" },
  { plural: "outcomes", path: "/api/v1/outcomes" },
  { plural: "units", path: "/api/v1/units" },
  { plural: "plans", path: "/api/v1/plans" },
  { plural: "composites", path: "/api/v1/composites" },
];

async function main(): Promise<void> {
  for (const { plural, path } of LISTS) {
    const name = `clocknext_list_${plural}`;
    console.log(name);

    // No args: one request, with limit=50 and nothing else.
    reply = { [plural]: [{ id: "a", isActive: true }], nextCursor: "a" };
    const plain = await call(name, {});
    check("sends one request to the list route", plain.requests === 1 && plain.url?.pathname === path, String(plain.url));
    check("always sends limit (50 by default)", plain.url?.searchParams.get("limit") === "50", String(plain.url));
    check("sends no active when it is left out", !plain.url?.searchParams.has("active"), String(plain.url));
    check("sends no cursor when it is left out", !plain.url?.searchParams.has("cursor"), String(plain.url));
    check("returns the items under their key", Array.isArray(plain.data[plural]), plain.text);
    check("returns nextCursor from the page", plain.data.nextCursor === "a", plain.text);

    // active=false → archived only, sent to the server.
    reply = { [plural]: [{ id: "b", isActive: false }], nextCursor: null };
    const archived = await call(name, { active: false });
    check("active=false sends active=false", archived.url?.searchParams.get("active") === "false", String(archived.url));
    check("active=false still sends limit", archived.url?.searchParams.get("limit") === "50", String(archived.url));
    check("nextCursor null on the last page", archived.data.nextCursor === null, archived.text);

    const active = await call(name, { active: true });
    check("active=true sends active=true", active.url?.searchParams.get("active") === "true", String(active.url));

    // limit and cursor are passed through.
    const paged = await call(name, { limit: 200, cursor: "cur_9" });
    check("limit is passed through", paged.url?.searchParams.get("limit") === "200", String(paged.url));
    check("cursor is passed through", paged.url?.searchParams.get("cursor") === "cur_9", String(paged.url));

    // The schema keeps limit within 1..200.
    check("limit 0 is refused", !parses(name, { limit: 0 }));
    check("limit 201 is refused", !parses(name, { limit: 201 }));
    check("limit 1.5 is refused", !parses(name, { limit: 1.5 }));

    // The text tells the agent about the order and the next page.
    const desc = tool(name).config.description ?? "";
    check("description says newest first", /newest first/i.test(desc), desc);
    check("description says how to get the next page", /nextCursor/.test(desc) && /cursor/.test(desc), desc);
    const shape = tool(name).config.inputSchema ?? {};
    check("has a cursor arg", "cursor" in shape);
    check("has a limit arg", "limit" in shape);
  }

  console.log("API client");
  for (const { plural, path } of LISTS) {
    reply = { [plural]: [], nextCursor: null };
    sent.length = 0;
    const api = (cnk as unknown as Record<string, { page: (p?: object) => Promise<unknown> }>)[plural];
    const out = (await api.page()) as { items?: unknown[]; nextCursor?: unknown };
    check(
      `${plural}.page() sends limit=50 to ${path}`,
      sent[0]?.pathname === path && sent[0]?.searchParams.get("limit") === "50",
      String(sent[0]),
    );
    check(`${plural}.page() returns { items, nextCursor }`, Array.isArray(out?.items) && out.nextCursor === null, JSON.stringify(out));
  }
  check(
    "the client has no list() that could call a list route without limit",
    LISTS.every(({ plural }) => !("list" in (cnk as unknown as Record<string, object>)[plural])),
  );

  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
