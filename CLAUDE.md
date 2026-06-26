# CLAUDE.md — second-opinion MCP server

Project guidance for AI agents working in this repo. For user-facing setup and
behavior, see `README.md`.

## What this is

An MCP (stdio) server that exposes local CLI coding agents — **Codex**,
**Gemini**, **Claude Code**, **GitHub Copilot** — as one-shot, read-only
"second opinion" tools (`ask_codex` / `ask_gemini` / `ask_claude` /
`ask_copilot`). Each call spawns the agent's CLI, feeds the prompt (over stdin,
or — for copilot, which has no stdin-prompt support — as a `--prompt=` argv
value), and returns the final answer. TypeScript, ESM, Node ≥ 20; build with
`npm run build`, test with `npm test` (`node --test` against `dist/`), lint with
`npm run lint` (Biome).

## Architecture

Agents are defined once and driven generically — **adding or changing an agent
is an `AgentDef` edit, not a handler/doctor edit**.

| File              | Responsibility                                                                 |
| ----------------- | ------------------------------------------------------------------------------ |
| `src/agents.ts`   | `runAgent` (spawn + bounded stream capture + timeout/kill), CLI resolution (`resolveCliEntry` for npm globals; `resolveNativeOrNpmCli` shared by claude/copilot), output helpers. No agent-specific logic. |
| `src/clis.ts`     | Per-CLI argv builders (`build{Codex,Gemini,Claude,Copilot}Argv`) and `geminiExtraEnv`. Pure; each takes an optional model (copilot's also takes the prompt). |
| `src/models.ts`   | Gemini model discovery (`listGeminiModels`) + ranking (`rankGeminiModels`), curated fallbacks, and the shared `SAFE_MODEL_RE`. |
| `src/registry.ts` | The `AgentDef` interface, the four agent definitions (`AGENTS`), per-agent model resolution + cache, and `runAgentWithFallback`. |
| `src/index.ts`    | MCP wiring: one generic handler registered for every `AgentDef`; input schema; drain-on-stdin-close. |
| `src/doctor.ts`   | `--doctor` health check; loops `AGENTS` through `runAgentWithFallback` and reports the model each used. |

`index.ts` and `doctor.ts` contain **no** per-agent branches — both iterate
`AGENTS`. Keep it that way.

## Model selection (the core policy)

Each agent resolves an **ordered list of model candidates, smartest-first**, and
`runAgentWithFallback` tries them in order:

1. First candidate that succeeds wins; its model is cached (`rememberModel`) so
   later calls in the same process skip dead candidates.
2. A failure that `def.isModelUnavailable(result)` recognizes (tier-gated,
   retired, or disabled model) advances to the next candidate.
3. Any other failure — or exhausting the list — returns the result as-is.

Selection precedence in `resolveModels`: explicit per-call `model` →
`SECOND_OPINION_<NAME>_MODEL` env override → cached winner prepended to → the
agent's
base list. An explicit/override model collapses the list to one entry (no
fallback). The cache is process-lifetime only, so a returning model (e.g. Fable
coming back online) is re-discovered on the next server start.

Per-agent base lists:
- **codex** → `[undefined]` (let the CLI pick its flagship; no `-m`).
- **claude** → `["claude-fable-5", "claude-opus-4-8", undefined]` (Fable is
  smartest but is currently disabled globally → falls through to Opus 4.8, then
  to the CLI's own configured default so a lower-tier account that can run
  neither high-end id still works).
- **gemini** → live ListModels ranking when `GEMINI_API_KEY` is in the server
  env (after the first success, the cached winner is reused without re-running
  discovery), else the curated list led by Google's `gemini-{pro,flash}-latest`
  aliases (which track the current generation server-side) down to concrete 2.5
  ids; always capped and ending in the `gemini-2.5-flash` safety net. Ranking
  is generation-first, then tier, so a newer family (`gemini-3-*`) outranks
  `gemini-2.5-*` regardless of tier (a current Flash can beat an older Pro);
  `geminiProbeList` keeps the best discovered Flash even when the cap would
  otherwise drop it behind tier-gated Pro candidates. Discovery is bounded by
  the call's remaining timeout budget.
- **copilot** → `["auto"]` (a single candidate, no fallback, like codex). We
  pass Copilot's own `--model auto` routing — which picks an appropriate model
  for the account and sidesteps the wonky per-model premium-request pricing —
  rather than relying on the CLI's configured default, which can be a stale id
  the API rejects.

### `isModelUnavailable` must be precise

It gates fallback, so it must match **only** "this model isn't available to me",
never auth failures or genuine task errors (those should surface, not silently
downgrade the model). Match against both `result.output` and `result.stderrTail`
(CLIs split these inconsistently — e.g. Claude prints its disabled-model notice
to stdout). Current matchers:
- **gemini:** `limit: 0` (tier-gate) or model-not-found — deliberately **not**
  generic 429s (a transient rate limit shouldn't downgrade the model).
- **claude:** a disabled-model notice (requires the name "Claude" on the line,
  so a service/account outage like "Service is currently unavailable" isn't
  misread) or unknown/invalid model.
- **codex:** none (single-candidate list, so no fallback to trigger).
- **copilot:** none (single `"auto"` candidate, so no fallback to trigger).

The whole fallback chain shares one `timeout_seconds` deadline
(`runAgentWithFallback`), so trying N candidates can't run N× the budget — each
later candidate gets only the remaining time.

When a model id or its error signature changes, update the base list / matcher
in `registry.ts` and add a case to `test/models.test.js`.

## Adding a new agent

1. Add argv/env builders to `src/clis.ts` (and a CLI resolver if needed).
2. Add one `AgentDef` to `AGENTS` in `src/registry.ts`: identity + description,
   `resolveCli`, `prepareContext`/`buildArgv`/`extraEnv`, `resolveModels` (its
   candidate strategy), `isModelUnavailable`, `extractAnswer`, `cleanup`.
3. That's it — `index.ts` registers the tool and `doctor.ts` checks it
   automatically. Add tests to `test/`.

## Conventions

- Validate any model id that reaches an argv against `SAFE_MODEL_RE` — a
  leading dash could smuggle a CLI flag (e.g. `--yolo`) into the spawned
  process. Discovered Gemini ids are already filtered through it.
- Keep agents read-only: don't add file-writing or shell-enabling flags.
  Copilot is the loose one — `--allow-all-tools` is required for its
  non-interactive mode, so its read-only guarantee rests on the deny rules
  (`--deny-tool write/shell/url`, which win because "denial rules always take
  precedence over allow rules, even --allow-all-tools") plus
  `--disable-builtin-mcps`. Don't remove a deny without re-checking the
  write/shell/network surface. Known gap: Copilot has no `--strict-mcp-config`
  equivalent, so user-configured MCP servers (`~/.copilot/mcp-config.json`)
  still load and the deny rules cover only built-in tools — documented in the
  README. Its prompt rides in a `--prompt=` argv value (no stdin support yet,
  github/copilot-cli #1046), so very large prompts can hit the OS arg-length
  limit.
- Match the existing style (2-space indent, double quotes); run `npm run lint`
  before finishing.
