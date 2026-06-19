import { randomUUID } from "node:crypto";
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
