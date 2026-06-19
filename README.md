# agentmcp — second-opinion MCP server

An MCP (stdio) server that exposes locally installed CLI coding agents —
**OpenAI Codex CLI**, **Google Gemini CLI**, and **Claude Code** — as one-shot
"second opinion" agents. It works in any MCP client: host it in Claude Code to
ask Codex/Gemini, or host it in Codex/Gemini to ask Claude.

| Tool         | What it does                                                            |
| ------------ | ----------------------------------------------------------------------- |
| `ask_codex`  | One-shot question to `codex exec` (read-only sandbox, no file edits)    |
| `ask_gemini` | One-shot question to `gemini` non-interactive mode (writes auto-denied) |
| `ask_claude` | One-shot question to `claude -p` (edits/shell/network tools denied)     |

Both tools take `prompt` (required), `cwd` (project root the agent may read),
`model` (optional override), and `timeout_seconds` (default 3600, the max). Calls are
stateless; Claude can invoke both tools in parallel.

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
claude mcp add --scope user second-opinion -- node /path/to/agentmcp/dist/index.js
```

Codex CLI:

```sh
codex mcp add second-opinion -- node /path/to/agentmcp/dist/index.js
```

Gemini CLI:

```sh
gemini mcp add --scope user second-opinion node /path/to/agentmcp/dist/index.js
```

## Prerequisites

Each tool only needs its own CLI, so install the ones you'll ask:

- `codex` and `gemini` installed as npm globals (`npm i -g @openai/codex
  @google/gemini-cli`) and authenticated.
  - Gemini: run `gemini` interactively once and complete login (e.g. "Login
    with Google") so cached OAuth credentials exist. Until then `ask_gemini`
    returns the CLI's auth error.
- `claude` installed (native installer or `npm i -g
  @anthropic-ai/claude-code`) and logged in.
- The CLIs are discovered automatically:
  - Windows: PATH scan for the `.cmd` shim (with `node_modules` beside it),
    plus the `%APPDATA%\npm` fallback. For claude, a PATH scan for the
    native `claude.exe` is tried first.
  - macOS / Linux: PATH scan for the bare shim, resolving npm's bin symlink
    to the package's JS entry, with a `<prefix>/lib/node_modules` fallback.
    For claude, a PATH entry that doesn't resolve to the npm package is
    treated as the native binary and run directly.
- If discovery fails (e.g. globals managed by volta or another
  nonstandard package manager), set
  `AGENTMCP_CODEX_JS` / `AGENTMCP_GEMINI_JS` to the absolute path of each
  CLI's JS entry point, or `AGENTMCP_CLAUDE_CLI` to the claude executable
  or its npm `cli.js`.

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
- `ask_claude` runs with `--strict-mcp-config` so the spawned Claude loads no
  MCP servers — this server is typically registered at user scope, and
  loading it would recurse into itself.
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
