# @clocknext/mcp

The **Clocknext MCP server** — meter usage, verify signals, and manage
usage‑based billing directly from AI coding tools (Claude Code, Cursor, Codex,
Antigravity, …) and any other [Model Context Protocol](https://modelcontextprotocol.io)
client.

It runs **locally over stdio**: your AI tool spawns it as a subprocess, and your
organisation's `cnk_…` API key stays in the server's environment — never in the
model's context.

This repo ships **two** things:

- **the MCP server** (`@clocknext/mcp`) — the tools an agent calls.
- **the `clocknext-onboarding` skill** — the step‑by‑step playbook that drives a
  full setup using those tools (human‑in‑the‑loop, sandbox‑first).

Install them together (the Claude Code plugin) or separately. Pick by what you
want and which agent you're on:

| Install | What you get | Works in |
| --- | --- | --- |
| **[Skill](#1--the-skill-every-ai-coding-agent)** — `npx skills add Clocknext-Inc/clocknext-mcp` | the guided onboarding flow | **every** agent (Claude Code, Cursor, Codex, Windsurf, Gemini, Antigravity, VS Code, …) |
| **[MCP server](#2--the-mcp-server-every-ai-coding-agent)** — `npx -y @clocknext/mcp` | the tools an agent calls | **every** MCP client |
| **[Plugin](#3--the-claude-code-plugin-claude-code-only)** — `/plugin install clocknext@clocknext` | MCP tools **+** skill, one step | **Claude Code only** |

The skill and the MCP server work together — the skill *drives* the tools — so for
the full guided experience install **both** (or just use the plugin, which bundles
them). The plugin is the one‑command option, but Claude Code only.

> A Clocknext API key is required for the tools: **Settings → API Keys** →
> `cnk_…`. It is a server‑side secret — keep it in env/secret config, never in
> client code or a repo.

---

## 1 — The skill (every AI coding agent)

The **`clocknext-onboarding`** skill is the guided playbook (detect models →
entitlements → plan → meter the codebase → test with a dummy customer). It
**drives the MCP tools**, so install the MCP server too (**§2 below**) — the skill
on its own has nothing to call.

Install it with **[`npx skills`](https://www.skills.sh)** — one command, works
across Claude Code, Cursor, Codex, Windsurf, Gemini, Antigravity, VS Code, and
~20 other agents. **Target your agent with `--agent`** so it lands where that
agent actually looks:

```bash
# user-wide (all projects), for a specific agent:
npx skills add Clocknext-Inc/clocknext-mcp --global --agent claude-code
# …or this project only:
npx skills add Clocknext-Inc/clocknext-mcp --agent claude-code
```

Swap `claude-code` for `cursor`, `codex`, `windsurf`, … (or `*` for every
detected agent). `npx skills list` shows what's installed;
`npx skills remove clocknext-onboarding` removes it. After installing, **restart
the agent** — most load skills at startup.

> **Claude Code, read this.** Claude Code only loads skills from
> `~/.claude/skills/`, `.claude/skills/`, or a plugin — **not** the CLI's default
> universal `.agents/skills/` folder. So you must pass `--agent claude-code`
> (as above), which installs to `~/.claude/skills/` (with `--global`) or
> `.claude/skills/`. A bare `npx skills add …` puts it in `.agents/skills/`, where
> Claude Code will never see it. Simplest of all for Claude Code: use the
> [plugin](#3--the-claude-code-plugin-claude-code-only) — it registers the skill
> natively and wires the MCP in one step.

<details>
<summary>Manual install (no CLI)</summary>

Copy the folder from the repo into your agent's skills directory:

```bash
git clone https://github.com/Clocknext-Inc/clocknext-mcp
# Claude Code — all projects:
mkdir -p ~/.claude/skills && cp -r clocknext-mcp/skills/clocknext-onboarding ~/.claude/skills/
# …or this project only: .claude/skills/
```

For tools without a native skills folder (Cursor / Windsurf / Codex / Antigravity),
point their rules file at `skills/clocknext-onboarding/SKILL.md` — e.g.
`.cursor/rules/clocknext-onboarding.md`, Windsurf Rules, or `AGENTS.md`. Keep the
`references/*.md` files alongside `SKILL.md`.
</details>

---

## 2 — The MCP server (every AI coding agent)

Gives you the **tools** the skill (and you) call — one stdio server,
`npx -y @clocknext/mcp`, with your `CLOCKNEXT_API_KEY` in its env.

Most clients take the **standard block** below — same JSON, they just differ on
the file it goes in:

```json
{
  "mcpServers": {
    "clocknext": {
      "command": "npx",
      "args": ["-y", "@clocknext/mcp"],
      "env": { "CLOCKNEXT_API_KEY": "cnk_your_key" }
    }
  }
}
```

### CLI agents

**Claude Code** — one command:

```bash
claude mcp add clocknext --env CLOCKNEXT_API_KEY=cnk_your_key -- npx -y @clocknext/mcp
```

**Gemini CLI** — `~/.gemini/settings.json` → the **standard block**.

**Codex** — `~/.codex/config.toml`:

```toml
[mcp_servers.clocknext]
command = "npx"
args = ["-y", "@clocknext/mcp"]
env = { CLOCKNEXT_API_KEY = "cnk_your_key" }
```

**GitHub Copilot CLI** — `copilot mcp add`, or `~/.copilot/mcp-config.json`:

```json
{
  "mcpServers": {
    "clocknext": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "@clocknext/mcp"],
      "env": { "CLOCKNEXT_API_KEY": "cnk_your_key" },
      "tools": ["*"]
    }
  }
}
```

**OpenCode** — `~/.config/opencode/opencode.json` (note: `mcp` root, `command`
is an array, env is `environment`):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "clocknext": {
      "type": "local",
      "command": ["npx", "-y", "@clocknext/mcp"],
      "environment": { "CLOCKNEXT_API_KEY": "cnk_your_key" },
      "enabled": true
    }
  }
}
```

**Factory (Droid)** — `droid mcp add`, or the **standard block** in its config
with `"type": "stdio"` added to the server:

```bash
droid mcp add --type stdio clocknext "npx -y @clocknext/mcp"
```

**Kimi Code** — `kimi mcp add clocknext -- npx -y @clocknext/mcp` (set
`CLOCKNEXT_API_KEY` in the environment; config lives in `~/.kimi/config.toml`).

### IDEs

**Cursor** — `.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global) → the
**standard block**.

**Windsurf** — `~/.codeium/windsurf/mcp_config.json` → the **standard block**.

**Antigravity** — its MCP settings JSON → the **standard block**.

**Kiro** — `.kiro/settings/mcp.json` (project) or `~/.kiro/settings/mcp.json`
(user) → the **standard block**. Kiro doesn't inherit your shell `PATH`, so if
`npx` isn't found, use its full path (`which npx`).

**VS Code** (native MCP / Copilot) — `.vscode/mcp.json` (uses `servers`, not
`mcpServers`):

```json
{
  "servers": {
    "clocknext": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@clocknext/mcp"],
      "env": { "CLOCKNEXT_API_KEY": "cnk_your_key" }
    }
  }
}
```

**Any other MCP client** — point it at the stdio command `npx -y @clocknext/mcp`
with `CLOCKNEXT_API_KEY` in env. `@clocknext/mcp` is also in the official
[MCP Registry](https://modelcontextprotocol.io/registry/about) as
`io.github.Clocknext-Inc/mcp`, so registry‑aware clients can discover it directly.
(The older entry `io.github.Clocknext/mcp` stops at 0.13.0: the GitHub
organisation was renamed to Clocknext-Inc, and the registry only lets it publish
under its own name.)

### Environment

| Variable | Required | Description |
| --- | --- | --- |
| `CLOCKNEXT_API_KEY` | yes | Your org's `cnk_…` key (Settings → API Keys). |
| `CLOCKNEXT_BASE_URL` | no | Override the API origin (e.g. a staging URL). Defaults to production. |
| `CLOCKNEXT_DOCS_URL` | no | Override the docs origin for the `search_docs`/`get_doc` tools. Defaults to `https://help.clocknext.com`. |

---

## 3 — The Claude Code plugin (Claude Code only)

The one‑command option — installs the MCP server **and** the `clocknext-onboarding`
skill together, and wires the API key for you. **Claude Code only** (the plugin
format is Claude Code's; other agents use §1 + §2 above).

```
/plugin marketplace add Clocknext-Inc/clocknext-mcp
/plugin install clocknext@clocknext
```

Claude Code prompts for your Clocknext API key at install (stored securely), runs
the bundled server, and auto‑discovers the skill from the plugin's `skills/`
folder. Verify:

- `/mcp` → the `clocknext` tools are listed.
- The skill triggers automatically when you start any Clocknext work (or check
  your installed skills).

No manual config, no env vars, nothing to build.

---

## Tools

| Tool | What it does |
| --- | --- |
| `clocknext_whoami` | Identify the org behind the key and whether it's **sandbox** or **live**. Call first. |
| `clocknext_list_models` | List enabled models + USD prices per 1M tokens. Use a `modelId` in signals. |
| `clocknext_add_model` | Enable a catalog model (autopriced); warns if it has no catalog price. |
| `clocknext_get_customer_balances` | A customer's current wallet / credit / outcome / unit balances. |
| `clocknext_get_customer_plan` | A customer's current active plan (from their purchase). |

Plus catalogue CRUD (`create_plan` / `create_credit` / `create_outcome` /
`create_unit` …), customer tools (`create_customer`, `create_purchase`,
`bulk_import_customers`), and the docs tools (`search_docs`, `get_doc`). Run
`/mcp` to see the full list.

A typical agent flow: `whoami` → `list_models` → `get_customer_plan` (confirm
the plan, and that every model and agent key the code will send resolves) → run
the product's own code so it fires a real signal through `@clocknext/sdk` →
the SDK's `signals.usageLog({ customerId })` (confirm it landed). The `clocknext-onboarding` skill
orchestrates all of this.

**The MCP configures billing but never meters it.** There is no record/track
tool by design, and no preview either: real signals come from your product's
code via the SDK (`signals.credit` / `.wallet` / `.outcome`), which is also the
only thing that proves the integration end-to-end. The SDK's `signals.usageLog()`
is the proof one landed; the MCP has no usage-read tool.

## Development

```bash
npm install
npm run build        # tsup → dist/index.js (executable bin)
npm run dev          # run from source via tsx
CLOCKNEXT_API_KEY=cnk_... npm start
```

Built on the official `@modelcontextprotocol/sdk`, with its own small `fetch`
client for the Clocknext API (`src/api.ts`), all bundled into `dist/` by tsup. stdio today; a hosted Streamable‑HTTP variant is planned.
Logs go to **stderr** (stdout is the protocol channel). The committed `dist/` is
what the plugin runs — rebuild and commit it on any code change.

### Releasing (maintainers) — automated

A tag push publishes **both** the npm package and the official MCP Registry entry,
via [`.github/workflows/publish-mcp.yml`](.github/workflows/publish-mcp.yml):

```bash
# 1. bump the version in package.json, server.json (both "version" fields),
#    src/index.ts and .claude-plugin/plugin.json; rebuild + commit:
npm run build && git commit -am "release: vX.Y.Z"

# 2. tag and push — CI does the rest:
git tag vX.Y.Z && git push origin main --tags
```

The workflow checks the tag matches `package.json`, builds, `npm publish`es (with
provenance), then authenticates to the registry with **GitHub OIDC** (no secret)
and publishes `server.json`. It hosts only metadata pointing at the npm package,
so the npm publish runs first.

**One‑time setup:** add an `NPM_TOKEN` secret (repo → Settings → Secrets → Actions).
To drop the token entirely, configure npm **trusted publishing** (OIDC) for
`@clocknext/mcp` on npmjs.com and delete the `NODE_AUTH_TOKEN` line.

<details>
<summary>Manual release (no CI)</summary>

```bash
npm publish --access public                 # npm first — the registry validates against it
# get the publisher CLI (Linux/macOS, no brew needed):
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher
./mcp-publisher login github                # device flow — must be a Clocknext org member
./mcp-publisher publish                     # reads server.json (name io.github.Clocknext-Inc/mcp)
```
</details>

See the [MCP Registry docs](https://modelcontextprotocol.io/registry/about).
