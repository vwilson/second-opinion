import os from "node:os";
import { type AgentResult, killAllAgents } from "./agents.js";
import { type AgentDef, AGENTS, runAgentWithFallback } from "./registry.js";

const DOCTOR_PROMPT =
  "This is an automated health check. Reply with the single word OK and nothing else.";
const DOCTOR_TIMEOUT_MS = 120_000;

interface DoctorReport {
  name: string;
  ok: boolean;
  lines: string[];
}

function errorMessage(err: unknown): string {
  return String(err instanceof Error ? err.message : err);
}

function failureLines(result: AgentResult): string[] {
  const seconds = Math.round(result.durationMs / 1000);
  const reason = result.timedOut
    ? `timed out after ${seconds}s`
    : `exited with code ${result.exitCode} after ${seconds}s`;
  const stderr = result.stderrTail.trim();
  return [
    `result: FAILED — ${reason}`,
    ...(stderr
      ? [`stderr: ${stderr.split(/\r?\n/).slice(-5).join("\n          ")}`]
      : []),
  ];
}

function okLine(result: AgentResult, answer: string): string {
  const seconds = Math.round(result.durationMs / 1000);
  const flat = answer.trim().replace(/\s+/g, " ");
  const snippet = flat.length > 120 ? `${flat.slice(0, 120)}...` : flat;
  return `result: OK in ${seconds}s — "${snippet}"`;
}

/**
 * Resolve the CLI and run the health-check prompt through it, exercising the
 * same model-candidate fallback the live tools use, and report which model
 * actually answered.
 */
async function check(def: AgentDef, cwd: string): Promise<DoctorReport> {
  let cli: ReturnType<AgentDef["resolveCli"]>;
  try {
    cli = def.resolveCli();
  } catch (err) {
    return { name: def.name, ok: false, lines: [errorMessage(err)] };
  }

  const outcome = await runAgentWithFallback(def, cli, {
    requested: undefined,
    prompt: DOCTOR_PROMPT,
    cwd,
    timeoutMs: DOCTOR_TIMEOUT_MS,
    onProgress: async () => {},
    remember: false,
  });

  const lines = [`entry: ${[cli.command, ...cli.prefixArgs].join(" ")}`];
  if (!outcome.ok) {
    return {
      name: def.name,
      ok: false,
      lines: [...lines, ...failureLines(outcome.result)],
    };
  }
  return {
    name: def.name,
    ok: true,
    lines: [
      ...lines,
      `model: ${outcome.model ?? "(CLI default)"}`,
      okLine(outcome.result, outcome.answer),
    ],
  };
}

/**
 * Resolve each CLI and run a one-line prompt through it, so a broken
 * install or expired login surfaces here instead of as an opaque tool error
 * mid-conversation. Returns the process exit code.
 */
export async function runDoctor(): Promise<number> {
  // a neutral directory: the health check should not explore user code
  const cwd = os.tmpdir();

  const shutdown = () => {
    void killAllAgents().finally(() => process.exit(130));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  console.log(
    "second-opinion doctor — sending a one-line prompt through each CLI (can take a minute)..."
  );
  const reports = await Promise.all(AGENTS.map((def) => check(def, cwd)));

  for (const report of reports) {
    console.log(`\n${report.name}:`);
    for (const line of report.lines) console.log(`  ${line}`);
  }

  const failed = reports.filter((r) => !r.ok).map((r) => r.name);
  console.log(
    failed.length === 0
      ? "\nall checks passed"
      : `\nfailed: ${failed.join(", ")}`
  );
  return failed.length === 0 ? 0 : 1;
}
