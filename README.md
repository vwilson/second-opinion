# agentmcp — second-opinion MCP server

An MCP (stdio) server for Claude Code that exposes the locally installed
**OpenAI Codex CLI** and **Google Gemini CLI** as one-shot "second opinion"
agents:

| Tool         | What it does                                                            |
| ------------ | ----------------------------------------------------------------------- |
| `ask_codex`  | One-shot question to `codex exec` (read-only sandbox, no file edits)    |
| `ask_gemini` | One-shot question to `gemini` non-interactive mode (writes auto-denied) |

Both tools take `prompt` (required), `cwd` (project root the agent may read),
`model` (optional override), and `timeout_seconds` (default 600). Calls are
stateless; Claude can invoke both tools in parallel.

## Build

Works on Windows, macOS, and Linux:

```sh
npm install
npm run build
```

## Register in Claude Code (user scope, all projects)

Windows:

```powershell
claude mcp add --scope user second-opinion -- node F:\VWI\agentmcp\dist\index.js
```

macOS / Linux:

```sh
claude mcp add --scope user second-opinion -- node /path/to/agentmcp/dist/index.js
```

## Prerequisites

- `codex` and `gemini` installed as npm globals (`npm i -g @openai/codex
  @google/gemini-cli`) and authenticated.
  - Gemini: run `gemini` interactively once and complete login (e.g. "Login
    with Google") so cached OAuth credentials exist. Until then `ask_gemini`
    returns the CLI's auth error.
- The CLIs are discovered automatically:
  - Windows: PATH scan for the `.cmd` shim (with `node_modules` beside it),
    plus the `%APPDATA%\npm` fallback.
  - macOS / Linux: PATH scan for the bare shim, resolving npm's bin symlink
    to the package's JS entry, with a `<prefix>/lib/node_modules` fallback.
- If discovery fails (e.g. globals managed by volta or another
  nonstandard package manager), set
  `AGENTMCP_CODEX_JS` / `AGENTMCP_GEMINI_JS` to the absolute path of each
  CLI's JS entry point.

## Notes

- Only `ask_codex` is sandboxed read-only (restricted token). `ask_gemini` is
  read-only by policy: non-interactive default approval mode auto-denies file
  edits and shell commands, but there is no OS sandbox and Gemini's network
  tools (web fetch, Google Search) remain available — don't point it at
  directories containing secrets.
- The server keeps long agent calls alive by sending MCP progress
  notifications every 10s. If a client ignores progress, set
  `MCP_TOOL_TIMEOUT=900000` in its environment as a fallback.
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
- Debugging: `npm run inspect` opens the MCP Inspector against the server.
