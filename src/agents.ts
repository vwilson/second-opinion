import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";

export interface AgentRunOptions {
  entry: string;
  argv: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  onProgress: (elapsedSec: number) => Promise<void>;
}

export interface AgentResult {
  ok: boolean;
  output: string;
  exitCode: number | null;
  timedOut: boolean;
  stderrTail: string;
  durationMs: number;
}

const STREAM_CAP = 5 * 1024 * 1024;
const PROGRESS_INTERVAL_MS = 10_000;
const POST_KILL_GRACE_MS = 5_000;

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function truncateMiddle(s: string, max = 50_000): string {
  if (s.length <= max) return s;
  const headLen = 20_000;
  const tailLen = max - headLen;
  const omitted = s.length - headLen - tailLen;
  return (
    s.slice(0, headLen) +
    `\n\n[... ${omitted} characters omitted ...]\n\n` +
    s.slice(-tailLen)
  );
}

const entryCache = new Map<string, string>();

/**
 * Locate the real JS entry point of an npm-global CLI. Node >= 20.12 refuses
 * to spawn .cmd shims without shell:true, and shell:true breaks argument
 * quoting, so we run `node <entry.js>` directly instead.
 */
export function resolveCliEntry(
  shimName: string,
  pkgRelEntry: string,
  envVar: string
): string {
  const cached = entryCache.get(envVar);
  if (cached !== undefined) return cached;

  const override = process.env[envVar];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `${envVar} is set to "${override}", but that file does not exist.`
      );
    }
    entryCache.set(envVar, override);
    return override;
  }

  const relParts = pkgRelEntry.split("/");
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  for (const dir of pathDirs) {
    if (!existsSync(path.join(dir, shimName))) continue;
    // npm invariant: the global shim sits beside the global node_modules
    const entry = path.join(dir, "node_modules", ...relParts);
    if (existsSync(entry)) {
      entryCache.set(envVar, entry);
      return entry;
    }
  }

  const appData = process.env.APPDATA;
  if (appData) {
    const fallback = path.join(appData, "npm", "node_modules", ...relParts);
    if (existsSync(fallback)) {
      entryCache.set(envVar, fallback);
      return fallback;
    }
  }

  throw new Error(
    `Could not locate ${shimName} on PATH or under %APPDATA%\\npm. ` +
      `Is the CLI installed globally via npm? You can also set ${envVar} ` +
      `to the absolute path of the CLI's JS entry point (${pkgRelEntry}).`
  );
}

async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
    return;
  }
  await new Promise<void>((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    killer.on("close", () => resolve());
    killer.on("error", () => resolve());
  });
}

export async function runAgent(opts: AgentRunOptions): Promise<AgentResult> {
  const start = Date.now();
  return await new Promise<AgentResult>((resolve) => {
    const child = spawn(process.execPath, [opts.entry, ...opts.argv], {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      if (stdout.length < STREAM_CAP) stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      if (stderr.length < STREAM_CAP) stderr += chunk;
    });

    // EPIPE guard: the CLI may exit before consuming stdin
    child.stdin.on("error", () => {});
    child.stdin.write(opts.prompt);
    child.stdin.end();

    const progressTimer = setInterval(() => {
      const elapsedSec = Math.round((Date.now() - start) / 1000);
      void opts.onProgress(elapsedSec).catch(() => {});
    }, PROGRESS_INTERVAL_MS);

    const settle = (exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearInterval(progressTimer);
      clearTimeout(killTimer);
      resolve({
        ok: !timedOut && exitCode === 0,
        output: stripAnsi(stdout),
        exitCode,
        timedOut,
        stderrTail: stripAnsi(stderr).slice(-2_000),
        durationMs: Date.now() - start,
      });
    };

    const killTimer = setTimeout(() => {
      timedOut = true;
      if (child.pid !== undefined) void killTree(child.pid);
      // if the streams never close after the kill, settle anyway
      setTimeout(() => settle(null), POST_KILL_GRACE_MS);
    }, opts.timeoutMs);

    child.on("error", (err) => {
      stderr += `\nspawn error: ${err.message}`;
      settle(null);
    });
    // 'close' (not 'exit') so stdout/stderr are fully flushed
    child.on("close", (code) => settle(code));
  });
}
