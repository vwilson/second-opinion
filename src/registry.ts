import { rm } from "node:fs/promises";
import process from "node:process";
import {
  type AgentResult,
  type CliCommand,
  cleanGeminiOutput,
  readFileCapped,
  resolveClaudeCli,
  runAgent,
} from "./agents.js";
import {
  buildClaudeArgv,
  buildCodexArgv,
  buildGeminiArgv,
  geminiExtraEnv,
  newCodexOutFile,
  resolveCodexEntry,
  resolveGeminiEntry,
} from "./clis.js";
import {
  GEMINI_FALLBACK_MODELS,
  GEMINI_SAFETY_NET,
  geminiProbeList,
  listGeminiModels,
  SAFE_MODEL_RE,
} from "./models.js";

// Per-invocation state an agent may need to thread from argv construction
// through answer extraction (codex writes its final message to a temp file).
export interface AgentContext {
  cwd: string;
  outFile?: string;
}

/**
 * Everything that differs between agents. The generic tool handler and the
 * doctor are driven entirely off this — adding an agent is one entry here, no
 * edits to index.ts or doctor.ts.
 *
 * `model` candidates are ordered smartest-first; the runner tries them in turn
 * and drops to the next only when `isModelUnavailable` recognizes the failure
 * (tier-gated / retired / disabled model), caching the first that works.
 */
export interface AgentDef {
  /** stable short id, also the SECOND_OPINION_<NAME>_MODEL env-override key */
  name: string;
  toolName: string;
  title: string;
  description: string;
  annotations: { readOnlyHint: boolean; openWorldHint: boolean };
  /** locate the CLI; may throw if it isn't installed */
  resolveCli(): CliCommand;
  prepareContext(cwd: string): AgentContext;
  buildArgv(model: string | undefined, ctx: AgentContext): string[];
  extraEnv(): Record<string, string> | undefined;
  /** ordered model candidates, smartest-first (cache- and override-aware).
   * `budgetMs` bounds any discovery I/O to the call's remaining timeout. */
  resolveModels(
    requested: string | undefined,
    budgetMs?: number
  ): Promise<(string | undefined)[]>;
  /** true when a failed run means "this model isn't available to me" */
  isModelUnavailable(result: AgentResult): boolean;
  extractAnswer(result: AgentResult, ctx: AgentContext): Promise<string>;
  cleanup(ctx: AgentContext): Promise<void>;
}

// Remembers the first model that worked for each agent this process, so later
// calls skip re-probing models that were unavailable on the first call. Reset
// on server restart, which is also when a returning model (e.g. Fable coming
// back online) gets re-discovered.
const modelCache = new Map<string, string | undefined>();

export function rememberModel(name: string, model: string | undefined): void {
  modelCache.set(name, model);
}

function dedupe(list: (string | undefined)[]): (string | undefined)[] {
  const seen = new Set<string>();
  const out: (string | undefined)[] = [];
  for (const m of list) {
    const key = m ?? "(default)";
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}

/** Prepend this agent's last-known-good model (if any) to its base list. */
function withCache(
  name: string,
  base: (string | undefined)[]
): (string | undefined)[] {
  const list = modelCache.has(name) ? [modelCache.get(name), ...base] : base;
  return dedupe(list);
}

// one stderr warning per agent whose env override we had to reject
const warnedBadOverride = new Set<string>();

/**
 * An explicit per-call model, else the SECOND_OPINION_<NAME>_MODEL override.
 * The per-call `model` is already validated by the tool's input schema; the env
 * override is operator-supplied, so validate it against the same rule before it
 * can reach an argv builder — an unsafe value (`--flag`, whitespace) is ignored
 * with a one-time warning so the call falls back to normal selection rather
 * than producing an invalid CLI invocation.
 */
function forcedModel(
  name: string,
  requested: string | undefined
): string | undefined {
  if (requested) return requested;
  const env = process.env[`SECOND_OPINION_${name.toUpperCase()}_MODEL`];
  if (!env) return undefined;
  if (!SAFE_MODEL_RE.test(env)) {
    if (!warnedBadOverride.has(name)) {
      warnedBadOverride.add(name);
      console.error(
        `second-opinion: ignoring SECOND_OPINION_${name.toUpperCase()}_MODEL ("${env}") — not a valid model id; using auto-selection instead.`
      );
    }
    return undefined;
  }
  return env;
}

function jsCli(entry: string): CliCommand {
  return { command: process.execPath, prefixArgs: [entry] };
}

// Smartest Claude coding models, smartest-first. Fable 5 is the most capable
// but is currently disabled globally; the runner falls through to Opus 4.8
// (and back to Fable automatically once it returns). Full ids, not short
// aliases, so selection is unambiguous. The final `undefined` is the CLI's own
// configured default (no `--model`): if an account can run neither high-end id,
// auto-selection still works exactly as it did before this feature existed
// rather than erroring out.
const CLAUDE_MODELS: (string | undefined)[] = [
  "claude-fable-5",
  "claude-opus-4-8",
  undefined,
];

const CODEX: AgentDef = {
  name: "codex",
  toolName: "ask_codex",
  title: "Ask OpenAI Codex (second opinion)",
  description:
    "Get a second opinion from OpenAI Codex (GPT-5-class coding agent) running locally with " +
    "read-only access to the user's files. One-shot and stateless: it explores the given cwd, " +
    "reasons about the code, and returns a single final answer. It cannot edit files or run " +
    "state-changing commands. Uses the codex CLI's own flagship model by default; override per " +
    "call with `model`. Use for: reviewing a plan or diff, debugging hypotheses, architecture " +
    "trade-offs, or cross-checking your own conclusion. Calls typically take 1-5 minutes. May " +
    "be called in parallel with ask_gemini.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  resolveCli: () => jsCli(resolveCodexEntry()),
  prepareContext: (cwd) => ({ cwd, outFile: newCodexOutFile() }),
  buildArgv: (model, ctx) =>
    buildCodexArgv(ctx.cwd, ctx.outFile as string, model),
  extraEnv: () => undefined,
  // codex tracks its own flagship; we don't second-guess it. A per-call /
  // env-override model still flows through.
  resolveModels: async (requested) => {
    const forced = forcedModel("codex", requested);
    return forced ? [forced] : withCache("codex", [undefined]);
  },
  isModelUnavailable: () => false,
  extractAnswer: async (result, ctx) => {
    let answer = "";
    if (ctx.outFile) {
      try {
        answer = (await readFileCapped(ctx.outFile)).trim();
      } catch {
        // fall back to stdout below
      }
    }
    return answer || result.output.trim();
  },
  cleanup: async (ctx) => {
    if (ctx.outFile) await rm(ctx.outFile, { force: true });
  },
};

const GEMINI: AgentDef = {
  name: "gemini",
  toolName: "ask_gemini",
  title: "Ask Google Gemini (second opinion)",
  description:
    "Get a second opinion from Google Gemini (large-context agent — good for questions spanning " +
    "many files) running locally over the user's files. One-shot and stateless: it explores the " +
    "given cwd, reasons about the code, and returns a single final answer. File edits and shell " +
    "commands are auto-denied (non-interactive default approval mode), but unlike ask_codex this " +
    "is CLI policy rather than an OS sandbox, and the agent can reach the network (web fetch, " +
    "Google Search) — avoid pointing it at directories containing secrets. Auto-selects the " +
    "smartest Gemini model your key can run (override per call with `model`). Use for: reviewing " +
    "a plan or diff, debugging hypotheses, architecture trade-offs, or cross-checking your own " +
    "conclusion. Calls typically take 1-5 minutes. May be called in parallel with ask_codex.",
  annotations: { readOnlyHint: true, openWorldHint: true },
  resolveCli: () => jsCli(resolveGeminiEntry()),
  prepareContext: (cwd) => ({ cwd }),
  buildArgv: (model) => buildGeminiArgv(model),
  extraEnv: () => geminiExtraEnv(),
  resolveModels: async (requested, budgetMs) => {
    const forced = forcedModel("gemini", requested);
    if (forced) return [forced];
    // once a model has worked this process, reuse it (via withCache) instead of
    // paying the ListModels round-trip — and its timeout — on every call
    if (modelCache.has("gemini")) {
      return withCache("gemini", [...GEMINI_FALLBACK_MODELS]);
    }
    const discovered = await listGeminiModels(process.env, budgetMs);
    // cap probing (first call may spawn the CLI once per tier-gated model), but
    // keep the best discovered Flash so a free-tier key whose Pro candidates
    // fail with `limit: 0` still reaches a current Flash before the safety net
    const base = geminiProbeList(discovered ?? [...GEMINI_FALLBACK_MODELS]);
    if (!base.includes(GEMINI_SAFETY_NET)) base.push(GEMINI_SAFETY_NET);
    return withCache("gemini", base);
  },
  // tier-gated (`limit: 0`) or retired/unknown ids; deliberately NOT generic
  // 429s, so a transient rate limit doesn't silently downgrade the model
  isModelUnavailable: (result) => {
    const s = `${result.output}\n${result.stderrTail}`;
    return (
      /limit:\s*0\b/i.test(s) ||
      /is not found for API version/i.test(s) ||
      (/\bNOT_FOUND\b|\b404\b/.test(s) && /model/i.test(s))
    );
  },
  extractAnswer: async (result) => cleanGeminiOutput(result.output),
  cleanup: async () => {},
};

const CLAUDE: AgentDef = {
  name: "claude",
  toolName: "ask_claude",
  title: "Ask Anthropic Claude (second opinion)",
  description:
    "Get a second opinion from Anthropic Claude (Claude Code CLI) running locally with read-only " +
    "access to the user's files. One-shot and stateless: it explores the given cwd, reasons " +
    "about the code, and returns a single final answer. File edits, shell commands, and network " +
    "tools are disabled by policy (--disallowedTools; not an OS sandbox). Auto-selects the " +
    "smartest available Claude model (override per call with `model`). Use for: reviewing a plan " +
    "or diff, debugging hypotheses, architecture trade-offs, or cross-checking your own " +
    "conclusion. Most useful when this server is hosted by a non-Claude client; from Claude Code " +
    "itself, prefer ask_codex/ask_gemini for an independent perspective. Calls typically take " +
    "1-5 minutes. May be called in parallel with the other tools.",
  annotations: { readOnlyHint: true, openWorldHint: false },
  resolveCli: () => resolveClaudeCli(),
  prepareContext: (cwd) => ({ cwd }),
  buildArgv: (model) => buildClaudeArgv(model),
  extraEnv: () => undefined,
  resolveModels: async (requested) => {
    const forced = forcedModel("claude", requested);
    return forced ? [forced] : withCache("claude", [...CLAUDE_MODELS]);
  },
  // matches the CLI's "Claude Fable 5 is currently unavailable" disabled-model
  // message and unknown/invalid-model errors; checks stdout and stderr since
  // the CLI prints the disabled notice to stdout. The "unavailable" branch
  // requires the name "Claude" on the line so a service/account-level outage
  // ("Service is currently unavailable") isn't misread as a model downgrade.
  isModelUnavailable: (result) => {
    const s = `${result.output}\n${result.stderrTail}`;
    return (
      /claude\b[^\n]*\b(currently unavailable|is unavailable)\b/i.test(s) ||
      /(unknown|invalid|unsupported) model/i.test(s) ||
      /model .*(not found|not available|does not exist)/i.test(s)
    );
  },
  extractAnswer: async (result) => result.output.trim(),
  cleanup: async () => {},
};

export const AGENTS: AgentDef[] = [CODEX, GEMINI, CLAUDE];

export interface FallbackRunOptions {
  requested: string | undefined;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  onProgress: (elapsedSec: number) => Promise<void>;
  /** cache the winning model for later calls (only for auto-selected runs) */
  remember: boolean;
  /** notified when a candidate is skipped as unavailable */
  onUnavailable?: (from: string | undefined, to: string | undefined) => void;
}

export interface FallbackOutcome {
  ok: boolean;
  /** the model that produced `result` */
  model: string | undefined;
  /** extracted answer on success, empty string on failure */
  answer: string;
  /** the final AgentResult (last attempt), for error formatting */
  result: AgentResult;
}

// Don't start another fallback candidate with less than this much of the call's
// timeout budget left — too little time to get a useful answer anyway.
const MIN_CANDIDATE_MS = 1_000;

/**
 * Run an agent through its ordered model candidates: first success wins (and is
 * cached when `remember`); a model-unavailable failure advances to the next
 * candidate; any other failure (or the last candidate) returns as-is.
 */
export async function runAgentWithFallback(
  def: AgentDef,
  cli: CliCommand,
  opts: FallbackRunOptions
): Promise<FallbackOutcome> {
  // `timeout_seconds` is a hard kill for the whole call, not per candidate:
  // start the deadline before model resolution (which, for Gemini, may block in
  // ListModels) and share it across the fallback chain, so discovery + trying N
  // models can't exceed the budget. Discovery itself is bounded by the budget,
  // and once too little is left to be worth another attempt, we stop.
  const deadline = Date.now() + opts.timeoutMs;

  let models = await def.resolveModels(opts.requested, opts.timeoutMs);
  if (models.length === 0) models = [undefined];

  let last: AgentResult | undefined;
  let lastModel: string | undefined;

  for (let i = 0; i < models.length; i++) {
    const model = models[i];
    const remainingMs = deadline - Date.now();
    if (last && remainingMs < MIN_CANDIDATE_MS) break;
    const ctx = def.prepareContext(opts.cwd);
    try {
      const result = await runAgent({
        command: cli.command,
        argv: [...cli.prefixArgs, ...def.buildArgv(model, ctx)],
        prompt: opts.prompt,
        cwd: opts.cwd,
        timeoutMs: remainingMs,
        extraEnv: def.extraEnv(),
        onProgress: opts.onProgress,
      });
      last = result;
      lastModel = model;

      if (result.ok) {
        const answer = await def.extractAnswer(result, ctx);
        if (opts.remember) rememberModel(def.name, model);
        return { ok: true, model, answer, result };
      }

      const hasNext = i < models.length - 1;
      if (hasNext && def.isModelUnavailable(result)) {
        opts.onUnavailable?.(model, models[i + 1]);
        continue;
      }
      return { ok: false, model, answer: "", result };
    } finally {
      await def.cleanup(ctx);
    }
  }

  // every candidate was unavailable
  return {
    ok: false,
    model: lastModel,
    answer: "",
    result: last as AgentResult,
  };
}
