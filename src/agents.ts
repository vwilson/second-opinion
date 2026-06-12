import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { open, readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

export interface AgentRunOptions {
  command: string;
  argv: string[];
  prompt: string;
  cwd: string;
  timeoutMs: number;
  extraEnv?: Record<string, string>;
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

export const STREAM_HEAD_CAP = 2_500_000;
export const STREAM_TAIL_CAP = 2_500_000;
const PROGRESS_INTERVAL_MS = 10_000;
const POST_KILL_GRACE_MS = 5_000;

// OSC (with payload, BEL- or ST-terminated), CSI, and remaining two-character
// ESC sequences. DCS/PM/APC payloads are not covered, but NO_COLOR is set on
// the children so escapes should be rare to begin with. The OSC terminator is
// mandatory: an unterminated `ESC ]` (quoted by the agent, or cut by the
// stream cap) is left intact rather than stripped through real output.
const ANSI_RE = new RegExp(
  "\\x1B\\][^\\x07\\x1B]*(?:\\x07|\\x1B\\\\)" +
    "|\\x1B\\[[0-?]*[ -/]*[@-~]" +
    "|\\x1B[@-Z\\\\^_]",
  "g"
);

export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function truncateMiddle(s: string, max = 50_000): string {
  if (s.length <= max) return s;
  const headLen = Math.floor(max * 0.4);
  const tailLen = max - headLen;
  const omitted = s.length - headLen - tailLen;
  return (
    s.slice(0, headLen) +
    `\n\n[... ${omitted} characters omitted ...]\n\n` +
    s.slice(-tailLen)
  );
}

export const FILE_READ_CAP = 5 * 1024 * 1024;
export const FILE_HEAD_BYTES = 256 * 1024;
export const FILE_TAIL_BYTES = 256 * 1024;

/**
 * Read a UTF-8 text file with bounded memory: files over FILE_READ_CAP are
 * read as head + tail only (a multi-byte char split at a read boundary
 * degrades to a replacement char, which is fine for truncated output).
 */
export async function readFileCapped(filePath: string): Promise<string> {
  const { size } = await stat(filePath);
  if (size <= FILE_READ_CAP) return readFile(filePath, "utf8");
  const fh = await open(filePath, "r");
  try {
    const head = Buffer.alloc(FILE_HEAD_BYTES);
    const tail = Buffer.alloc(FILE_TAIL_BYTES);
    // regular-file reads normally fill the buffer, but short reads are legal
    // (e.g. the file shrank after stat), so slice to what was actually read
    // rather than decoding zero padding into the result
    const headRead = await fh.read(head, 0, FILE_HEAD_BYTES, 0);
    const tailRead = await fh.read(tail, 0, FILE_TAIL_BYTES, size - FILE_TAIL_BYTES);
    const omitted = size - headRead.bytesRead - tailRead.bytesRead;
    return (
      head.toString("utf8", 0, headRead.bytesRead) +
      `\n\n[... ${omitted} bytes omitted ...]\n\n` +
      tail.toString("utf8", 0, tailRead.bytesRead)
    );
  } finally {
    await fh.close();
  }
}

/**
 * Collects a stream with bounded memory: the first STREAM_HEAD_CAP chars are
 * kept verbatim, then a rolling buffer keeps the last STREAM_TAIL_CAP chars,
 * so the end of the stream (final answers, fatal errors) always survives.
 */
export function makeStreamCollector() {
  let head = "";
  const tail: string[] = [];
  let tailLen = 0;
  let dropped = 0;
  return {
    push(chunk: string): void {
      if (head.length < STREAM_HEAD_CAP) {
        const room = STREAM_HEAD_CAP - head.length;
        if (chunk.length <= room) {
          head += chunk;
          return;
        }
        // Chunk straddles the cap: keep the part that fits in head, and let
        // the overflow fall through into the rolling tail buffer below.
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      tail.push(chunk);
      tailLen += chunk.length;
      while (tail.length > 1 && tailLen - tail[0].length >= STREAM_TAIL_CAP) {
        tailLen -= tail[0].length;
        dropped += tail[0].length;
        tail.shift();
      }
    },
    read(): string {
      const joined = tail.join("");
      return dropped > 0
        ? `${head}\n[... ${dropped} characters dropped ...]\n${joined}`
        : head + joined;
    },
  };
}

const GEMINI_NOISE = [
  /^Loaded cached credentials\.\s*$/,
  /^Warning: 256-color support not detected\./,
  /^Ripgrep is not available\. Falling back to GrepTool\.\s*$/,
];

export function cleanGeminiOutput(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !GEMINI_NOISE.some((re) => re.test(line)))
    .join("\n")
    .trim();
}

const entryCache = new Map<string, string>();

/**
 * Locate the real JS entry point of an npm-global CLI given its bare shim
 * name (e.g. "codex"). Node >= 20.12 refuses to spawn .cmd shims without
 * shell:true, and shell:true breaks argument quoting, so we run
 * `node <entry.js>` directly instead.
 */
export function resolveCliEntry(
  shimName: string,
  pkgRelEntries: string[],
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

  const isWindows = process.platform === "win32";
  const shimFile = isWindows ? `${shimName}.cmd` : shimName;
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const shimDirs = pathDirs.filter((dir) =>
    existsSync(path.join(dir, shimFile))
  );

  if (!isWindows) {
    // npm installs the POSIX global bin as a symlink straight to the
    // package's bin JS (lib/node_modules/<pkg>/bin/*.js); resolving it
    // works regardless of where the npm prefix lives. Only accept targets
    // inside the expected package, so a stray same-named symlink earlier on
    // PATH can't make us run unrelated JS.
    const expectedSuffixes = pkgRelEntries.map(
      (rel) => path.sep + path.join("node_modules", ...rel.split("/"))
    );
    for (const dir of shimDirs) {
      try {
        const target = realpathSync(path.join(dir, shimFile));
        if (expectedSuffixes.some((suffix) => target.endsWith(suffix))) {
          entryCache.set(envVar, target);
          return target;
        }
      } catch {
        // symlink loop, permissions, etc.; fall through to the layout search
      }
    }
  }

  const appData = process.env.APPDATA;
  const moduleRoots = [
    ...shimDirs.flatMap((dir) =>
      isWindows
        ? // Windows npm invariant: the global shim sits beside node_modules
          [path.join(dir, "node_modules")]
        : // POSIX npm prefix layout: shim in <prefix>/bin, packages in
          // <prefix>/lib/node_modules
          [
            path.join(dir, "..", "lib", "node_modules"),
            path.join(dir, "node_modules"),
          ]
    ),
    ...(isWindows && appData
      ? [path.join(appData, "npm", "node_modules")]
      : []),
  ];
  for (const root of moduleRoots) {
    for (const rel of pkgRelEntries) {
      const entry = path.join(root, ...rel.split("/"));
      if (existsSync(entry)) {
        entryCache.set(envVar, entry);
        return entry;
      }
    }
  }

  const searched = isWindows
    ? "PATH or under %APPDATA%\\npm"
    : "PATH or the npm global prefix";
  throw new Error(
    `Could not locate ${shimFile} on ${searched}. ` +
      `Is the CLI installed globally via npm (npm i -g)? You can also set ` +
      `${envVar} to the absolute path of the CLI's JS entry point ` +
      `(${pkgRelEntries[0]}).`
  );
}

/**
 * How to invoke a CLI: either a native executable run directly, or a JS entry
 * point run via the current Node binary.
 */
export interface CliCommand {
  command: string;
  prefixArgs: string[];
}

const CLAUDE_PKG_ENTRY = "@anthropic-ai/claude-code/cli.js";
const CLAUDE_ENV_VAR = "AGENTMCP_CLAUDE_CLI";

let claudeCliCache: CliCommand | undefined;

function asCliCommand(target: string): CliCommand {
  return target.endsWith(".js") || target.endsWith(".mjs")
    ? { command: process.execPath, prefixArgs: [target] }
    : { command: target, prefixArgs: [] };
}

/**
 * Locate the Claude Code CLI. Unlike codex/gemini it ships two ways: the
 * native installer puts a standalone executable on PATH (~/.local/bin), and
 * the npm global install puts a shim beside node_modules. Native is checked
 * first since it is the recommended install.
 */
export function resolveClaudeCli(): CliCommand {
  if (claudeCliCache) return claudeCliCache;

  const override = process.env[CLAUDE_ENV_VAR];
  if (override) {
    if (!existsSync(override)) {
      throw new Error(
        `${CLAUDE_ENV_VAR} is set to "${override}", but that file does not exist.`
      );
    }
    return (claudeCliCache = asCliCommand(override));
  }

  const isWindows = process.platform === "win32";
  const pathDirs = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const expectedSuffix =
    path.sep + path.join("node_modules", ...CLAUDE_PKG_ENTRY.split("/"));

  if (isWindows) {
    for (const dir of pathDirs) {
      const exe = path.join(dir, "claude.exe");
      if (existsSync(exe)) {
        return (claudeCliCache = { command: exe, prefixArgs: [] });
      }
    }
    const jsRoots = [
      ...pathDirs
        .filter((dir) => existsSync(path.join(dir, "claude.cmd")))
        .map((dir) => path.join(dir, "node_modules")),
      ...(process.env.APPDATA
        ? [path.join(process.env.APPDATA, "npm", "node_modules")]
        : []),
    ];
    for (const root of jsRoots) {
      const entry = path.join(root, ...CLAUDE_PKG_ENTRY.split("/"));
      if (existsSync(entry)) {
        return (claudeCliCache = {
          command: process.execPath,
          prefixArgs: [entry],
        });
      }
    }
  } else {
    for (const dir of pathDirs) {
      const shim = path.join(dir, "claude");
      if (!existsSync(shim)) continue;
      try {
        const target = realpathSync(shim);
        if (target.endsWith(expectedSuffix)) {
          // npm global: bin symlink straight to the package's cli.js
          return (claudeCliCache = {
            command: process.execPath,
            prefixArgs: [target],
          });
        }
        // native installer: a standalone binary (possibly symlinked into
        // ~/.local/bin); run it directly
        return (claudeCliCache = { command: target, prefixArgs: [] });
      } catch {
        // symlink loop, permissions, etc.; try the next PATH entry
      }
    }
  }

  throw new Error(
    `Could not locate the claude CLI on PATH. Install Claude Code (native ` +
      `installer or npm i -g @anthropic-ai/claude-code), or set ` +
      `${CLAUDE_ENV_VAR} to the CLI's absolute path (the native executable ` +
      `or ${CLAUDE_PKG_ENTRY}).`
  );
}

const liveChildren = new Set<number>();

/** Kill every agent process tree still running (used at server shutdown). */
export async function killAllAgents(): Promise<void> {
  await Promise.all([...liveChildren].map((pid) => killTree(pid)));
}

async function killTree(pid: number): Promise<void> {
  if (process.platform !== "win32") {
    // agents are spawned detached (own process group) on POSIX, so a group
    // signal reaches their helper processes too
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
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
    const child = spawn(opts.command, opts.argv, {
      cwd: opts.cwd,
      shell: false,
      windowsHide: true,
      // own process group on POSIX so killTree can signal the whole tree
      detached: process.platform !== "win32",
      env: { ...process.env, NO_COLOR: "1", ...opts.extraEnv },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const stdoutCol = makeStreamCollector();
    const stderrCol = makeStreamCollector();
    let timedOut = false;
    let settled = false;

    const pid = child.pid;
    if (pid !== undefined) {
      liveChildren.add(pid);
      if (process.platform === "win32") {
        // prune at 'exit': taskkill /T walks the tree from the root, so a
        // dead root PID is useless for cleanup and could be reused by an
        // unrelated process while a grandchild delays 'close'
        child.on("exit", () => liveChildren.delete(pid));
      } else {
        // prune at 'close': the PID doubles as the detached process group
        // id, which cannot be reused while any group member survives, so
        // keeping it lets shutdown kill stragglers that outlive the leader
        child.on("close", () => liveChildren.delete(pid));
      }
      child.on("error", () => liveChildren.delete(pid));
    }

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdoutCol.push(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => stderrCol.push(chunk));

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
        output: stripAnsi(stdoutCol.read()),
        exitCode,
        timedOut,
        stderrTail: stripAnsi(stderrCol.read()).slice(-2_000),
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
      stderrCol.push(`\nspawn error: ${err.message}`);
      settle(null);
    });
    // 'close' (not 'exit') so stdout/stderr are fully flushed
    child.on("close", (code) => settle(code));
  });
}
