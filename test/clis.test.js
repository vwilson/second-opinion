import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  buildCodexArgv,
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
