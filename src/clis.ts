import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { resolveCliEntry } from "./agents.js";

/** Locate the codex CLI's JS entry point. */
export function resolveCodexEntry(): string {
  return resolveCliEntry(
    "codex",
    ["@openai/codex/bin/codex.js"],
    "SECOND_OPINION_CODEX_JS"
  );
}

/** Locate the gemini CLI's JS entry point. */
export function resolveGeminiEntry(): string {
  return resolveCliEntry(
    "gemini",
    ["@google/gemini-cli/bundle/gemini.js", "@google/gemini-cli/dist/index.js"],
    "SECOND_OPINION_GEMINI_JS"
  );
}

/** A unique temp file for codex's -o (last agent message) output. */
export function newCodexOutFile(): string {
  return path.join(os.tmpdir(), `second-opinion-codex-${randomUUID()}.txt`);
}

export function buildCodexArgv(
  cwd: string,
  outFile: string,
  model?: string
): string[] {
  return [
    "exec",
    "--skip-git-repo-check",
    // a user-level `windows.sandbox = "elevated"` setting cannot complete its
    // setup when codex runs headless ("spawn setup refresh" exec errors);
    // unelevated still enforces read-only via a restricted token. On POSIX
    // codex uses its platform-native sandbox, so the override is
    // Windows-only.
    ...(process.platform === "win32"
      ? ["-c", 'windows.sandbox="unelevated"']
      : []),
    "-s",
    "read-only",
    "--color",
    "never",
    "--ephemeral",
    "-C",
    cwd,
    ...(model ? ["-m", model] : []),
    "-o",
    outFile,
    "-",
  ];
}

export function buildGeminiArgv(model?: string): string[] {
  return [...(model ? ["-m", model] : []), "--approval-mode", "default"];
}

export function buildClaudeArgv(model?: string): string[] {
  return [
    "-p",
    "--output-format",
    "text",
    // one-shot means one-shot: don't save the prompt/transcript to the
    // user's session state (the ask_codex equivalent is --ephemeral)
    "--no-session-persistence",
    // don't load the user's MCP servers: faster startup, and this server is
    // typically registered at user scope, so loading them would recurse
    // into ourselves
    "--strict-mcp-config",
    // load no settings files at all: user/project settings can carry hooks
    // (arbitrary shell commands on tool events, including PreToolUse on
    // read-only tools like Read/Grep), permission allow rules, and
    // additionalDirectories that widen reads beyond the given cwd
    "--setting-sources",
    "",
    // belt and braces should a settings source slip back in: hooks off and
    // no extra readable directories
    "--settings",
    '{"disableAllHooks":true,"permissions":{"additionalDirectories":[]}}',
    ...(model ? ["--model", model] : []),
    // headless -p mode auto-denies tools that need approval, and with no
    // settings sources there are no allow rules to re-enable them; deny the
    // dangerous ones anyway (deny beats allow) plus the tools that don't
    // need permission at all (EnterWorktree/ExitWorktree write to disk).
    // PowerShell is the Bash-equivalent shell tool on Windows installs;
    // Monitor runs background commands.
    "--disallowedTools",
    "Bash",
    "PowerShell",
    "Monitor",
    "EnterWorktree",
    "ExitWorktree",
    "Write",
    "Edit",
    "NotebookEdit",
    "WebFetch",
    "WebSearch",
  ];
}

// Active throwaway COPILOT_HOMEs, so a forced shutdown (SIGINT/SIGTERM while a
// call is still running) can remove any whose per-call cleanup didn't run.
const activeCopilotHomes = new Set<string>();

// Strip `//` line and `/* */` block comments, string-aware so a comment marker
// inside a quoted value is preserved.
function stripComments(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i++; // the loop's i++ eats \n
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++; // skip the '*'; the loop's i++ skips the '/'
    } else {
      out += c;
    }
  }
  return out;
}

// Drop trailing commas before `}`/`]`, string-aware so a comma inside a value
// is preserved. Run on comment-free text so the lookahead need only skip space.
function dropTrailingCommas(text: string): string {
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      continue;
    }
    if (c === ",") {
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      if (text[j] === "}" || text[j] === "]") continue; // trailing comma → drop
    }
    out += c;
  }
  return out;
}

// Copilot's config.json is JSON-with-comments and may carry trailing commas;
// parse it tolerantly rather than letting a stray comment silently drop the
// auth copy (which would log out a no-keychain user).
function parseJsonc(text: string): unknown {
  return JSON.parse(dropTrailingCommas(stripComments(text)));
}

/**
 * Create a throwaway COPILOT_HOME so each ask_copilot call runs with an
 * isolated config: the user's own MCP servers, hooks, plugins, and saved
 * permissions (all keyed off ~/.copilot) are not loaded, the workspace is
 * treated as untrusted (so a repo's `.github/hooks` and `.mcp.json` don't run),
 * and the session transcript stays in this dir (removed in cleanup) instead of
 * persisting to ~/.copilot/session-state. `disableAllHooks` is also written
 * explicitly as defense-in-depth — it disables repo- and user-level hooks
 * (policy hooks, set by a machine admin, can't be and are trusted).
 */
export function newCopilotHome(): string {
  const dir = path.join(os.tmpdir(), `second-opinion-copilot-${randomUUID()}`);
  // 0700: the live session transcript (prompts + responses) lands in here, so
  // keep other local users on a shared host from reading it before cleanup.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  activeCopilotHomes.add(dir);

  // Preserve auth WITHOUT importing trust or settings: a headless login with no
  // OS keychain stores the token in <home>/config.json (Copilot's
  // storeTokenPlaintext fallback). Copy ONLY the auth field (`loggedInUsers`)
  // into the isolated home — never `trustedFolders`, `installedPlugins`, or
  // migrated legacy settings — so the workspace stays untrusted. A keychain
  // login keeps no token here and needs nothing copied.
  const srcHome =
    process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  const srcConfig = path.join(srcHome, "config.json");
  if (existsSync(srcConfig)) {
    try {
      const cfg = parseJsonc(readFileSync(srcConfig, "utf8"));
      if (cfg && typeof cfg === "object" && "loggedInUsers" in cfg) {
        writeFileSync(
          path.join(dir, "config.json"),
          JSON.stringify({
            loggedInUsers: (cfg as { loggedInUsers: unknown }).loggedInUsers,
          }),
          { mode: 0o600 } // may hold a plaintext token
        );
      }
    } catch {
      // unreadable / non-JSON / no plaintext token; keychain logins don't need it
    }
  }

  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ disableAllHooks: true }),
    { mode: 0o600 }
  );
  return dir;
}

/** Remove one isolated home and stop tracking it (per-call cleanup). */
export function removeCopilotHome(dir: string): void {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // best effort
  }
  activeCopilotHomes.delete(dir);
}

/**
 * Remove every isolated home still tracked. Runs from a `process.on("exit")`
 * hook so a forced shutdown (where the per-call cleanup never got to run) does
 * not leave token-bearing temp dirs behind. Sync, because exit hooks must be.
 */
export function cleanupCopilotHomes(): void {
  for (const dir of activeCopilotHomes) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; a still-running child may hold files open on Windows
    }
  }
  activeCopilotHomes.clear();
}

export function buildCopilotArgv(
  model: string | undefined,
  prompt: string
): string[] {
  return [
    // Non-interactive: run one prompt and exit. Copilot has no stdin-prompt
    // support yet (github/copilot-cli #1046), so the prompt is passed as an
    // argv value — it is visible in process listings, and very large prompts
    // can hit the OS argument-length limit. The `--prompt=` (`=`) form keeps a
    // prompt that starts with "-" from being parsed as a flag.
    "--silent", // print only the final agent response, no tool-run chrome
    "--no-color", // plain text (NO_COLOR is also set on the child env)
    "--no-auto-update", // don't pause to download a CLI update mid-call
    "--no-remote-export", // don't export the session to GitHub web/mobile
    // Allow-list the tools the model can even see: just file read + search.
    // This is the primary read-only mechanism — it removes write/shell, the
    // network tools (web_fetch/web_search), `skill` (which can read outside the
    // cwd), and everything else by construction, rather than denying the
    // dangerous ones one kind at a time. --allow-all-tools then auto-approves
    // these three so the non-interactive run never blocks on a prompt.
    "--available-tools=view,grep,glob",
    "--allow-all-tools",
    // Belt-and-braces under the allow-list (deny beats allow): block the tool
    // kinds outright in case a build ignores --available-tools.
    "--deny-tool",
    "write", // file-creating/modifying tools
    "--deny-tool",
    "shell", // shell exec (also the write-via-redirection vector)
    "--deny-tool",
    "url", // network URL access (web-fetch)
    "--disable-builtin-mcps", // no GitHub MCP server (no network / GitHub writes)
    "--no-ask-user", // never block waiting to ask the user a question
    // Copilot's default read scope is cwd + the OS temp dir; this drops the
    // temp-dir half so reads stay within the cwd.
    "--disallow-temp-dir",
    ...(model ? ["--model", model] : []),
    `--prompt=${prompt}`,
  ];
}

/**
 * Env for the spawned Copilot: point COPILOT_HOME at the isolated config dir,
 * and neutralize inherited env that would widen the read scope or steer the
 * isolated review:
 * - `COPILOT_CUSTOM_INSTRUCTIONS_DIRS` / `COPILOT_SKILLS_DIRS` → "" so the child
 *   can't load instructions or skills from directories outside the cwd.
 * - every `GITHUB_COPILOT_PROMPT_MODE_*` toggle (workspace MCP servers, project
 *   extensions, hooks, ...) → "false" so it can't load repo-controlled code
 *   without interactive trust.
 * These default off / empty; we never want them on for a read-only call. The
 * isolated, untrusted home already blocks most of this, but neutralize the env
 * too so an operator's stray export can't flip it on.
 */
export function copilotExtraEnv(
  home: string,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const extra: Record<string, string> = {
    COPILOT_HOME: home,
    COPILOT_CUSTOM_INSTRUCTIONS_DIRS: "",
    COPILOT_SKILLS_DIRS: "",
  };
  for (const key of Object.keys(env)) {
    if (key.startsWith("GITHUB_COPILOT_PROMPT_MODE_")) extra[key] = "false";
  }
  return extra;
}

export function geminiExtraEnv(
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // headless gemini cannot run the interactive folder-trust flow
  const extraEnv: Record<string, string> = {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  };
  // the CLI refuses the stored oauth-personal auth type when headless;
  // GOOGLE_GENAI_USE_GCA routes it to the same cached Google login. Skip
  // when another auth method is already configured in the environment.
  if (!env.GEMINI_API_KEY && !env.GOOGLE_GENAI_USE_VERTEXAI) {
    extraEnv.GOOGLE_GENAI_USE_GCA = "true";
  }
  return extraEnv;
}
