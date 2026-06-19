import { existsSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  type AgentResult,
  type CliCommand,
  killAllAgents,
  truncateMiddle,
} from "./agents.js";
import { SAFE_MODEL_RE } from "./models.js";
import { type AgentDef, AGENTS, runAgentWithFallback } from "./registry.js";

if (process.argv.includes("--doctor")) {
  const { runDoctor } = await import("./doctor.js");
  process.exit(await runDoctor());
}

const sharedShape = {
  prompt: z
    .string()
    .min(1)
    .describe(
      "The full, self-contained question or task. The agent has NO memory of previous calls and " +
        "cannot see this conversation — include all relevant context, absolute file paths, code " +
        "snippets, and the specific question you want answered."
    ),
  cwd: z
    .string()
    .optional()
    .describe(
      "Absolute path to the project directory the agent should explore (it can read files under " +
        "this root). Always pass the project root of the code under discussion. Defaults to the " +
        "MCP server's own working directory, which is rarely what you want."
    ),
  model: z
    .string()
    // a leading dash could smuggle a CLI flag (e.g. --yolo) into the argv
    .regex(
      SAFE_MODEL_RE,
      "model must be a plain model id (letters, digits, . _ : / -; no leading dash)"
    )
    .optional()
    .describe(
      "Model override. Omit to auto-select the smartest model the agent's account can run " +
        "(recommended)."
    ),
  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(3600)
    .default(600)
    .describe(
      "Hard kill timeout. Default 600s; these agents often need several minutes for codebase questions."
    ),
};

interface SharedArgs {
  prompt: string;
  cwd?: string;
  model?: string;
  timeout_seconds: number;
}

// extra is the SDK's RequestHandlerExtra; typed loosely so this file doesn't
// depend on SDK internals beyond _meta and sendNotification
interface HandlerExtra {
  _meta?: { progressToken?: string | number };
  sendNotification: (notification: {
    method: "notifications/progress";
    params: {
      progressToken: string | number;
      progress: number;
      message: string;
    };
  }) => Promise<void>;
}

function makeProgressReporter(label: string, extra: HandlerExtra) {
  const progressToken = extra._meta?.progressToken;
  return async (elapsedSec: number) => {
    if (progressToken === undefined) return;
    try {
      await extra.sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: elapsedSec,
          message: `${label} running... (${elapsedSec}s elapsed)`,
        },
      });
    } catch {
      // progress is best-effort; never fail the call over it
    }
  };
}

function textResult(text: string, isError = false) {
  return { content: [{ type: "text" as const, text }], isError };
}

function errorResult(
  label: string,
  result: AgentResult
): ReturnType<typeof textResult> {
  const seconds = Math.round(result.durationMs / 1000);
  const reason = result.timedOut
    ? `timed out after ${seconds}s and was killed`
    : `exited with code ${result.exitCode} after ${seconds}s`;
  return textResult(
    `${label} ${reason}.\n` +
      `--- stderr tail ---\n${result.stderrTail || "(empty)"}\n` +
      `--- stdout tail ---\n${result.output.slice(-2_000) || "(empty)"}`,
    true
  );
}

function resolveCwd(cwd: string | undefined): string {
  const resolved = cwd ?? process.cwd();
  if (!existsSync(resolved) || !statSync(resolved).isDirectory()) {
    throw new Error(`cwd "${resolved}" does not exist or is not a directory.`);
  }
  return resolved;
}

// resolves to the repo-root package.json from both src/ (dev) and dist/
const { version } = createRequire(import.meta.url)("../package.json") as {
  version: string;
};

const server = new McpServer({ name: "second-opinion", version });

// When the client closes stdin we must exit (so no orphaned server processes
// linger), but only after in-flight agent calls have settled.
let inflight = 0;
let stdinEnded = false;
let exitScheduled = false;

function maybeExitAfterDrain() {
  if (!stdinEnded || inflight > 0 || exitScheduled) return;
  exitScheduled = true;
  // the SDK writes the response to stdout after the handler resolves; give it
  // time to flush before exiting
  setTimeout(() => process.exit(0), 2_000);
}

function draining<A extends unknown[], R>(
  handler: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    inflight++;
    try {
      return await handler(...args);
    } finally {
      inflight--;
      maybeExitAfterDrain();
    }
  };
}

// One generic handler for every agent: resolve the CLI, then run the agent's
// ordered model candidates with availability-based fallback (see registry.ts).
function makeHandler(def: AgentDef) {
  return draining(async (args: SharedArgs, extra) => {
    let cli: CliCommand;
    let cwd: string;
    try {
      cli = def.resolveCli();
      cwd = resolveCwd(args.cwd);
    } catch (err) {
      return textResult(String(err instanceof Error ? err.message : err), true);
    }

    const outcome = await runAgentWithFallback(def, cli, {
      requested: args.model,
      prompt: args.prompt,
      cwd,
      timeoutMs: args.timeout_seconds * 1000,
      onProgress: makeProgressReporter(def.name, extra as HandlerExtra),
      // only cache the auto-selected winner; an explicit per-call model
      // shouldn't pin the default for later calls
      remember: args.model === undefined,
    });

    if (!outcome.ok) return errorResult(def.name, outcome.result);
    return textResult(truncateMiddle(outcome.answer));
  });
}

for (const def of AGENTS) {
  server.registerTool(
    def.toolName,
    {
      title: def.title,
      description: def.description,
      inputSchema: sharedShape,
      annotations: def.annotations,
    },
    makeHandler(def)
  );
}

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("second-opinion MCP server running on stdio");

process.stdin.on("end", () => {
  stdinEnded = true;
  maybeExitAfterDrain();
});
function shutdown() {
  // don't let agent processes outlive the server; the fallback timer covers
  // a hung taskkill
  const fallback = setTimeout(() => process.exit(0), 3_000);
  void killAllAgents().finally(() => {
    clearTimeout(fallback);
    process.exit(0);
  });
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
