import { rm } from "node:fs/promises";
import os from "node:os";
import {
  type AgentResult,
  type CliCommand,
  cleanGeminiOutput,
  killAllAgents,
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

async function checkCodex(cwd: string): Promise<DoctorReport> {
  let entry: string;
  try {
    entry = resolveCodexEntry();
  } catch (err) {
    return { name: "codex", ok: false, lines: [errorMessage(err)] };
  }
  const outFile = newCodexOutFile();
  try {
    const result = await runAgent({
      command: process.execPath,
      argv: [entry, ...buildCodexArgv(cwd, outFile)],
      prompt: DOCTOR_PROMPT,
      cwd,
      timeoutMs: DOCTOR_TIMEOUT_MS,
      onProgress: async () => {},
    });
    const lines = [`entry: ${entry}`];
    if (!result.ok) {
      return {
        name: "codex",
        ok: false,
        lines: [...lines, ...failureLines(result)],
      };
    }
    let answer = "";
    try {
      answer = (await readFileCapped(outFile)).trim();
    } catch {
      // fall back to stdout below
    }
    if (!answer) answer = result.output.trim();
    return {
      name: "codex",
      ok: true,
      lines: [...lines, okLine(result, answer)],
    };
  } finally {
    await rm(outFile, { force: true });
  }
}

async function checkGemini(cwd: string): Promise<DoctorReport> {
  let entry: string;
  try {
    entry = resolveGeminiEntry();
  } catch (err) {
    return { name: "gemini", ok: false, lines: [errorMessage(err)] };
  }
  const result = await runAgent({
    command: process.execPath,
    argv: [entry, ...buildGeminiArgv()],
    prompt: DOCTOR_PROMPT,
    cwd,
    timeoutMs: DOCTOR_TIMEOUT_MS,
    extraEnv: geminiExtraEnv(),
    onProgress: async () => {},
  });
  const lines = [`entry: ${entry}`];
  if (!result.ok) {
    return {
      name: "gemini",
      ok: false,
      lines: [...lines, ...failureLines(result)],
    };
  }
  const answer = cleanGeminiOutput(result.output);
  return {
    name: "gemini",
    ok: true,
    lines: [...lines, okLine(result, answer)],
  };
}

async function checkClaude(cwd: string): Promise<DoctorReport> {
  let cli: CliCommand;
  try {
    cli = resolveClaudeCli();
  } catch (err) {
    return { name: "claude", ok: false, lines: [errorMessage(err)] };
  }
  const result = await runAgent({
    command: cli.command,
    argv: [...cli.prefixArgs, ...buildClaudeArgv()],
    prompt: DOCTOR_PROMPT,
    cwd,
    timeoutMs: DOCTOR_TIMEOUT_MS,
    onProgress: async () => {},
  });
  const lines = [`entry: ${[cli.command, ...cli.prefixArgs].join(" ")}`];
  if (!result.ok) {
    return {
      name: "claude",
      ok: false,
      lines: [...lines, ...failureLines(result)],
    };
  }
  return {
    name: "claude",
    ok: true,
    lines: [...lines, okLine(result, result.output)],
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
  const reports = await Promise.all([
    checkCodex(cwd),
    checkGemini(cwd),
    checkClaude(cwd),
  ]);

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
