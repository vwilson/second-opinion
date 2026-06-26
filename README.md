# second-opinion — MCP server

An MCP (stdio) server that exposes locally installed CLI coding agents —
**OpenAI Codex CLI**, **Google Gemini CLI**, **Claude Code**, and **GitHub
Copilot CLI** — as one-shot "second opinion" agents. It works in any MCP client:
host it in Claude Code to ask Codex/Gemini/Copilot, or host it in Codex/Gemini to
ask Claude.

| Tool          | What it does                                                            |
| ------------- | ----------------------------------------------------------------------- |
| `ask_codex`   | One-shot question to `codex exec` (read-only sandbox, no file edits)    |
| `ask_gemini`  | One-shot question to `gemini` non-interactive mode (writes auto-denied) |
| `ask_claude`  | One-shot question to `claude -p` (edits/shell/network tools denied)     |
| `ask_copilot` | One-shot question to `copilot -p` (write/shell/network tools denied)    |

Each tool takes `prompt` (required), `cwd` (project root the agent may read),
`model` (optional — omit to auto-select the smartest model the agent can run;
see [Model selection](#model-selection)), and `timeout_seconds` (default 3600,
the max). Calls are stateless and can run in parallel.

## Build

Works on Windows, macOS, and Linux:

```sh
npm install
npm run build
```

## Register in an MCP client

Claude Code (user scope, all projects):

```powershell
# Windows
claude mcp add --scope user second-opinion -- node F:\VWI\agentmcp\dist\index.js
# macOS / Linux
claude mcp add --scope user second-opinion -- node /path/to/second-opinion/dist/index.js
```

Codex CLI:

```sh
codex mcp add second-opinion -- node /path/to/second-opinion/dist/index.js
```

Gemini CLI:

```sh
gemini mcp add --scope user second-opinion node /path/to/second-opinion/dist/index.js
```

GitHub Copilot CLI:

```sh
copilot mcp add second-opinion -- node /path/to/second-opinion/dist/index.js
```

(`ask_copilot` runs each call against an isolated config home, so registering
`second-opinion` here does not cause the spawned Copilot to re-load it — no
recursion. See [Notes](#notes).)

## Prerequisites

Each tool only needs its own CLI, so install the ones you'll ask:

- `codex` and `gemini` installed as npm globals (`npm i -g @openai/codex
  @google/gemini-cli`) and authenticated.
  - Gemini: run `gemini` interactively once and complete login (e.g. "Login
    with Google") so cached OAuth credentials exist. Until then `ask_gemini`
    returns the CLI's auth error.
- `claude` installed (native installer or `npm i -g
  @anthropic-ai/claude-code`) and logged in.
- `copilot` (GitHub Copilot CLI) installed (`winget install GitHub.Copilot`,
  or `npm i -g @github/copilot`) and authenticated — run `copilot` once and
  `/login`, or set `GH_TOKEN` / `GITHUB_TOKEN` in the server's environment.
  Until then `ask_copilot` returns the CLI's auth error.
- The CLIs are discovered automatically:
  - Windows: PATH scan for the `.cmd` shim (with `node_modules` beside it),
    plus the `%APPDATA%\npm` fallback. For claude and copilot, a PATH scan for
    the native `claude.exe` / `copilot.exe` is tried first.
  - macOS / Linux: PATH scan for the bare shim, resolving npm's bin symlink
    to the package's JS entry, with a `<prefix>/lib/node_modules` fallback.
    For claude and copilot, a PATH entry that doesn't resolve to the npm
    package is treated as the native binary and run directly.
- If discovery fails (e.g. globals managed by volta or another
  nonstandard package manager), set
  `SECOND_OPINION_CODEX_JS` / `SECOND_OPINION_GEMINI_JS` to the absolute path
  of each CLI's JS entry point, `SECOND_OPINION_CLAUDE_CLI` to the claude
  executable or its npm `cli.js`, or `SECOND_OPINION_COPILOT_CLI` to the
  copilot executable or its npm `npm-loader.js`.

## Model selection

When you omit `model`, each agent **auto-selects the smartest model it can
actually run**, with graceful fallback. Each agent resolves an ordered list of
candidates (smartest first); the first that answers wins and is cached for the
rest of the process. A candidate that fails with a *model-unavailable* error
(tier-gated, retired, or temporarily disabled) is skipped and the next is tried;
any other failure is returned as-is. This means a model going offline (e.g.
Claude Fable being disabled) or being absent from your tier (e.g. a free-tier
key can't run `gemini-2.5-pro`) is handled automatically, and a model coming
back online is picked up on the next server start.

| Agent   | Default candidates (smartest → fallback)                                  |
| ------- | ------------------------------------------------------------------------- |
| codex   | the `codex` CLI's own flagship model (no `-m` passed)                      |
| gemini  | discovered from the ListModels API and ranked (newest generation first, then pro > flash > flash-lite within a generation), else the `gemini-pro-latest` → `gemini-flash-latest` → `gemini-2.5-pro` → `gemini-2.5-flash` curated list |
| claude  | `claude-fable-5` → `claude-opus-4-8`                                       |
| copilot | Copilot's own `--model auto` routing (it picks a model for your account)   |

- **Gemini discovery needs `GEMINI_API_KEY` in the server's environment.** With
  it, the smartest model your key can run is discovered live via the ListModels
  REST API. Without it (e.g. the OAuth-only setup), the curated list leads with
  Google's `gemini-{pro,flash}-latest` aliases, which Google hot-swaps to the
  current generation server-side — so no-key users still reach the newest models
  without this server being updated. Either way, `gemini-2.5-flash` is the final
  safety net, and tier-gated models (`limit: 0`) are skipped automatically.
- **Copilot** is passed an explicit `--model auto`, so it routes to a model
  appropriate for your account (and sidesteps the per-model premium-request
  pricing) instead of relying on its configured default, which can be a stale id
  the API rejects. A per-call or env-override `model` still wins.
- **Per-call override:** pass `model` on the tool call to force a specific model
  (skips discovery and fallback).
- **Persistent override:** set `SECOND_OPINION_CODEX_MODEL`,
  `SECOND_OPINION_GEMINI_MODEL`, `SECOND_OPINION_CLAUDE_MODEL`, or
  `SECOND_OPINION_COPILOT_MODEL` to pin a default model for that agent.
- `npm run doctor` prints the model each agent actually used.

## Notes

- Only `ask_codex` is sandboxed read-only (restricted token). `ask_gemini` is
  read-only by policy: non-interactive default approval mode auto-denies file
  edits and shell commands, but there is no OS sandbox and Gemini's network
  tools (web fetch, Google Search) remain available — don't point it at
  directories containing secrets. `ask_claude` is likewise read-only by
  policy, in layers: `--setting-sources ""` loads no user/project settings
  (so no hooks, no permission allow rules, no additionalDirectories), an
  inline `--settings` override pins hooks off and extra read directories
  empty, and `--disallowedTools` denies shell (Bash/PowerShell/Monitor),
  file edits, worktree creation, and network tools — deny rules take
  precedence over any allow rules.
- `ask_copilot` is read-only by policy too. Non-interactive Copilot requires
  `--allow-all-tools` (otherwise it blocks on approval prompts), so the
  read-only guarantee rests on deny rules, which win — "denial rules always
  take precedence over allow rules, even --allow-all-tools": `--deny-tool
  write` (file edits), `--deny-tool shell` (shell exec, which is also the
  write-via-redirection and run-a-network-command vector), and `--deny-tool
  url` (the web-fetch tool). `--disable-builtin-mcps` drops the bundled GitHub
  MCP server (no GitHub API/network), and `--disallow-temp-dir` drops Copilot's
  default access to the OS temp directory (its default read scope is the cwd
  plus the temp dir), keeping reads within the given cwd. Like `ask_gemini`,
  this is CLI policy, not an OS sandbox.
- `ask_copilot` runs each call against an **isolated, throwaway config home**:
  it points `COPILOT_HOME` at a fresh temp dir (removed afterward), which Copilot
  lacks a `--strict-mcp-config` equivalent for otherwise. This means the user's
  own `~/.copilot/mcp-config.json` servers do not load (closing the gap that
  deny rules cover only built-in tools), user/plugin hooks do not load, the
  workspace is treated as untrusted so a repo's `.github/hooks` do not run (we
  also write `disableAllHooks` into the isolated home), and the session
  transcript is ephemeral — not written to `~/.copilot/session-state` and, with
  `--no-remote-export`, not synced to GitHub web/mobile. Only machine-admin
  *policy* hooks (which Copilot never lets a session disable) can still run.
- `ask_copilot` passes the prompt as a `--prompt=` command-line value: the
  Copilot CLI has no stdin-prompt support yet ([copilot-cli
  #1046](https://github.com/github/copilot-cli/issues/1046)), so unlike the
  other agents (which use stdin) the prompt is **visible in process listings**
  (`ps`/`/proc`) while the call runs, and a very large prompt can hit the OS
  argument-length limit. It also runs with `--silent` (only the final answer,
  no tool-run chrome) and `--no-auto-update` (no mid-call self-update).
- The server keeps long agent calls alive by sending MCP progress
  notifications every 10s. If a client ignores progress, set
  `MCP_TOOL_TIMEOUT` in its environment to at least the `timeout_seconds`
  you use, in milliseconds, as a fallback — `MCP_TOOL_TIMEOUT=3600000` to
  cover the 3600s default. A smaller value (e.g. `900000`) caps such calls
  client-side well before the server hard kill fires.
- On Windows, codex runs with `-c windows.sandbox="unelevated"`: a
  user-level `sandbox = "elevated"` config cannot complete its setup when
  codex runs headless (all shell commands fail with "windows sandbox: spawn
  setup refresh"). The unelevated sandbox still enforces read-only via a
  restricted token. On macOS/Linux the override is not passed; codex
  enforces read-only via its platform-native sandbox (e.g. Seatbelt on
  macOS).
- Gemini gets two env vars when spawned: `GEMINI_CLI_TRUST_WORKSPACE=true`
  (headless runs cannot complete the interactive folder-trust flow) and
  `GOOGLE_GENAI_USE_GCA=true` (the CLI refuses the stored `oauth-personal`
  auth type when headless; this routes it to the same cached Google login).
  The latter is skipped if `GEMINI_API_KEY` or `GOOGLE_GENAI_USE_VERTEXAI`
  is already set.
- After editing `src/`, run `npm run build`; Claude Code picks up the new
  build the next time it starts the server (`/mcp` → reconnect, or restart
  the session).
- Health check: `npm run doctor` (or `node dist/index.js --doctor`) resolves
  each CLI and runs a one-line prompt through it from a neutral directory,
  printing the resolved entry paths and pass/fail with stderr on failure.
  Useful after install, after re-authenticating, or when a tool starts
  erroring mid-conversation.
- Debugging: `npm run inspect` opens the MCP Inspector against the server.
