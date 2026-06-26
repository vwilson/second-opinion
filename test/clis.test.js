import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildClaudeArgv,
  buildCodexArgv,
  buildCopilotArgv,
  buildGeminiArgv,
  geminiExtraEnv,
  newCodexOutFile,
} from "../dist/clis.js";

test("buildCodexArgv produces the read-only exec invocation", () => {
  const argv = buildCodexArgv("/some/project", "/tmp/out.txt");
  assert.equal(argv[0], "exec");
  assert.ok(argv.includes("--skip-git-repo-check"));
  assert.ok(argv.includes("--ephemeral"));
  assert.equal(argv[argv.indexOf("-s") + 1], "read-only");
  assert.equal(argv[argv.indexOf("--color") + 1], "never");
  assert.equal(argv[argv.indexOf("-C") + 1], "/some/project");
  assert.equal(argv[argv.indexOf("-o") + 1], "/tmp/out.txt");
  assert.equal(argv[argv.length - 1], "-", "prompt must come from stdin");
  assert.ok(!argv.includes("-m"), "no model flag unless requested");
  if (process.platform === "win32") {
    assert.equal(argv[argv.indexOf("-c") + 1], 'windows.sandbox="unelevated"');
  } else {
    assert.ok(!argv.includes("-c"), "sandbox override is Windows-only");
  }
});

test("buildCodexArgv passes the model override through", () => {
  const argv = buildCodexArgv("/p", "/tmp/o.txt", "gpt-5-codex");
  assert.equal(argv[argv.indexOf("-m") + 1], "gpt-5-codex");
});

test("newCodexOutFile returns unique paths in the temp dir", () => {
  const a = newCodexOutFile();
  const b = newCodexOutFile();
  assert.notEqual(a, b);
  assert.equal(path.dirname(a), os.tmpdir());
});

test("buildGeminiArgv uses non-interactive default approval mode", () => {
  assert.deepEqual(buildGeminiArgv(), ["--approval-mode", "default"]);
  assert.deepEqual(buildGeminiArgv("gemini-2.5-pro"), [
    "-m",
    "gemini-2.5-pro",
    "--approval-mode",
    "default",
  ]);
});

test("buildClaudeArgv produces an isolated read-only print invocation", () => {
  const argv = buildClaudeArgv();
  assert.equal(argv[0], "-p");
  assert.equal(argv[argv.indexOf("--output-format") + 1], "text");
  assert.ok(argv.includes("--strict-mcp-config"), "must not load MCP servers");
  assert.ok(
    argv.includes("--no-session-persistence"),
    "must not save the transcript to the user's session state"
  );
  assert.equal(
    argv[argv.indexOf("--setting-sources") + 1],
    "",
    "must load no settings files"
  );
  assert.deepEqual(JSON.parse(argv[argv.indexOf("--settings") + 1]), {
    disableAllHooks: true,
    permissions: { additionalDirectories: [] },
  });
  const denied = argv.slice(argv.indexOf("--disallowedTools") + 1);
  for (const tool of [
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
  ]) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
  assert.ok(!argv.includes("--model"), "no model flag unless requested");
});

test("buildClaudeArgv passes the model override through", () => {
  const argv = buildClaudeArgv("claude-opus-4-8");
  assert.equal(argv[argv.indexOf("--model") + 1], "claude-opus-4-8");
});

test("buildCopilotArgv produces a read-only non-interactive invocation", () => {
  const argv = buildCopilotArgv(undefined, "review this code");
  // non-interactive, clean, isolated
  assert.ok(argv.includes("--silent"), "must print only the agent response");
  assert.ok(argv.includes("--no-auto-update"), "must not pause to self-update");
  assert.ok(
    argv.includes("--allow-all-tools"),
    "required for non-interactive mode"
  );
  // the dangerous tools are denied — deny beats --allow-all-tools
  const denied = argv.reduce((acc, a, i) => {
    if (a === "--deny-tool") acc.push(argv[i + 1]);
    return acc;
  }, []);
  for (const tool of ["write", "shell", "url"]) {
    assert.ok(denied.includes(tool), `${tool} must be denied`);
  }
  assert.ok(
    argv.includes("--disable-builtin-mcps"),
    "must not load the GitHub MCP server"
  );
  assert.ok(argv.includes("--no-ask-user"), "must not block on questions");
  assert.ok(
    argv.includes("--disallow-temp-dir"),
    "the OS temp-dir read exception is dropped"
  );
  assert.ok(!argv.includes("--model"), "no model flag unless requested");
  // the prompt is an argv value (no stdin support); the `=` form keeps a
  // dash-leading prompt from being parsed as a flag
  assert.equal(argv.at(-1), "--prompt=review this code");
});

test("buildCopilotArgv passes the model and keeps a dash-leading prompt safe", () => {
  const argv = buildCopilotArgv("auto", "--look at this");
  assert.equal(argv[argv.indexOf("--model") + 1], "auto");
  assert.equal(
    argv.at(-1),
    "--prompt=--look at this",
    "prompt must be bound with = so it is not read as a flag"
  );
});

test("geminiExtraEnv enables GCA only when no other auth is configured", () => {
  assert.deepEqual(geminiExtraEnv({}), {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
    GOOGLE_GENAI_USE_GCA: "true",
  });
  assert.deepEqual(geminiExtraEnv({ GEMINI_API_KEY: "k" }), {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  });
  assert.deepEqual(geminiExtraEnv({ GOOGLE_GENAI_USE_VERTEXAI: "true" }), {
    GEMINI_CLI_TRUST_WORKSPACE: "true",
  });
});
