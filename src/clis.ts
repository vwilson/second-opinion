import { randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
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

/**
 * Create a throwaway COPILOT_HOME so each ask_copilot call runs with an
 * isolated config: the user's own MCP servers, hooks, plugins, and saved
 * permissions (all keyed off ~/.copilot) are not loaded, the workspace is
 * treated as untrusted (so a repo's `.github/hooks` don't run), and the session
 * transcript stays in this dir (removed in cleanup) instead of persisting to
 * ~/.copilot/session-state. `disableAllHooks` is also written explicitly as
 * defense-in-depth — it disables repo- and user-level hooks (policy hooks, set
 * by a machine admin, can't be and are trusted).
 */
export function newCopilotHome(): string {
  const dir = path.join(os.tmpdir(), `second-opinion-copilot-${randomUUID()}`);
  // 0700: the live session transcript (prompts + responses) lands in here, so
  // keep other local users on a shared host from reading it before cleanup.
  mkdirSync(dir, { recursive: true, mode: 0o700 });

  // Preserve auth without importing the rest of the user's config: a headless
  // login with no OS keychain stores the OAuth token in <home>/config.json
  // (Copilot's storeTokenPlaintext fallback), so copy just that one file —
  // otherwise pointing COPILOT_HOME at a fresh dir would log such a user out.
  // mcp-config.json, hooks/, plugins/, and the user's settings.json are
  // deliberately NOT copied; that isolation is the whole point.
  const srcHome =
    process.env.COPILOT_HOME ?? path.join(os.homedir(), ".copilot");
  const srcConfig = path.join(srcHome, "config.json");
  if (existsSync(srcConfig)) {
    try {
      const destConfig = path.join(dir, "config.json");
      copyFileSync(srcConfig, destConfig);
      chmodSync(destConfig, 0o600); // may hold a plaintext token
    } catch {
      // best effort; a keychain-based login doesn't need this file
    }
  }

  writeFileSync(
    path.join(dir, "settings.json"),
    JSON.stringify({ disableAllHooks: true }),
    { mode: 0o600 }
  );
  return dir;
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
    // --allow-all-tools is required for non-interactive mode; the deny rules
    // below still win ("denial rules always take precedence over allow rules,
    // even --allow-all-tools"), so read tools auto-run while the dangerous
    // ones stay blocked.
    "--allow-all-tools",
    "--deny-tool",
    "write", // block file-creating/modifying tools
    "--deny-tool",
    "shell", // block shell exec (also the write-via-redirection vector)
    "--deny-tool",
    "url", // block network URL access (the web-fetch tool)
    "--disable-builtin-mcps", // no GitHub MCP server (no network / GitHub writes)
    "--no-ask-user", // never block waiting to ask the user a question
    // Copilot's default read scope is cwd + the OS temp dir; this drops the
    // temp-dir half so reads stay within the cwd.
    "--disallow-temp-dir",
    ...(model ? ["--model", model] : []),
    `--prompt=${prompt}`,
  ];
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
