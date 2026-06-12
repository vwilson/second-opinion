# agentmcp — second-opinion MCP server

An MCP (stdio) server for Claude Code that exposes the locally installed
**OpenAI Codex CLI** and **Google Gemini CLI** as read-only "second opinion"
agents:

| Tool         | What it does                                                          |
| ------------ | --------------------------------------------------------------------- |
| `ask_codex`  | One-shot question to `codex exec` (read-only sandbox, no file edits)  |
| `ask_gemini` | One-shot question to `gemini` non-interactive mode (default approvals) |

Both tools take `prompt` (required), `cwd` (project root the agent may read),
`model` (optional override), and `timeout_seconds` (default 600). Calls are
stateless; Claude can invoke both tools in parallel.

## Build

```powershell
npm install
npm run build
```

## Register in Claude Code (user scope, all projects)

```powershell
claude mcp add --scope user second-opinion -- node F:\VWI\agentmcp\dist\index.js
```

## Prerequisites

- `codex` and `gemini` installed as npm globals and authenticated.
  - Gemini: run `gemini` interactively once and complete login (e.g. "Login
    with Google") so non-interactive mode has a stored auth method. Until
    then `ask_gemini` returns the CLI's auth error.
- If the CLIs are not found automatically (PATH scan + `%APPDATA%\npm`), set
  `AGENTMCP_CODEX_JS` / `AGENTMCP_GEMINI_JS` to the absolute path of each
  CLI's JS entry point.

## Notes

- The server keeps long agent calls alive by sending MCP progress
  notifications every 10s. If a client ignores progress, set
  `MCP_TOOL_TIMEOUT=900000` in its environment as a fallback.
- Codex runs with `-c windows.sandbox="unelevated"`: a user-level
  `sandbox = "elevated"` config cannot complete its setup when codex runs
  headless (all shell commands fail with "windows sandbox: spawn setup
  refresh"). The unelevated sandbox still enforces read-only via a
  restricted token.
- After editing `src/`, run `npm run build`; Claude Code picks up the new
  build the next time it starts the server (`/mcp` → reconnect, or restart
  the session).
- Debugging: `npm run inspect` opens the MCP Inspector against the server.
