import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runAgent } from "../dist/agents.js";

// fixtures must live OUTSIDE test/: `node --test` treats every .js file
// under a directory named test as a test file, so fixtures placed here
// would be executed by the runner itself (hang.js then never lets it exit)
const fixturesDir = fileURLToPath(new URL("../fixtures/", import.meta.url));
const fixture = (name) => path.join(fixturesDir, name);
const agentsModuleUrl = new URL("../dist/agents.js", import.meta.url).href;
const noProgress = async () => {};

// fixtures are JS entry points, so they run via the current Node binary
function baseOpts(entry) {
  return {
    command: process.execPath,
    argv: [entry],
    prompt: "hello stdin",
    cwd: process.cwd(),
    timeoutMs: 30_000,
    onProgress: noProgress,
  };
}

test("runAgent captures stdout of a successful run", async () => {
  const result = await runAgent(baseOpts(fixture("echo.js")));
  assert.equal(result.ok, true);
  assert.equal(result.exitCode, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.output, "hello stdin");
});

test("runAgent reports nonzero exit with stderr tail", async () => {
  const result = await runAgent(baseOpts(fixture("fail.js")));
  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.timedOut, false);
  assert.ok(result.output.includes("partial output"));
  assert.ok(result.stderrTail.includes("something went wrong"));
});

test("runAgent kills a hung process at the timeout", async () => {
  const result = await runAgent({
    ...baseOpts(fixture("hang.js")),
    timeoutMs: 1_500,
  });
  assert.equal(result.ok, false);
  assert.equal(result.timedOut, true);
  assert.ok(result.durationMs >= 1_500);
  assert.ok(result.output.includes("started"));
});

test("runAgent clears the post-kill grace timer once streams close", async () => {
  const script = `
    import { runAgent } from ${JSON.stringify(agentsModuleUrl)};
    const result = await runAgent({
      command: process.execPath,
      argv: [${JSON.stringify(fixture("hang.js"))}],
      prompt: "hello stdin",
      cwd: ${JSON.stringify(process.cwd())},
      timeoutMs: 250,
      onProgress: async () => {},
    });
    if (!result.timedOut) {
      console.error("expected runAgent to time out");
      process.exit(1);
    }
  `;

  const started = Date.now();
  const child = spawn(
    process.execPath,
    ["--input-type=module", "--eval", script],
    {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    }
  );

  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error("timed-out child process did not exit promptly"));
    }, 4_500);
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      resolve(code);
    });
  });

  assert.equal(exit, 0, stderr);
  assert.ok(Date.now() - started < 4_500);
});

test("runAgent passes extraEnv and sets NO_COLOR", async () => {
  const result = await runAgent({
    ...baseOpts(fixture("print-env.js")),
    extraEnv: { SECOND_OPINION_TEST_EXTRA: "yes" },
  });
  assert.equal(result.ok, true);
  assert.equal(result.output, "extra=yes;no_color=1");
});

test("runAgent surfaces a missing entry file as a failed run", async () => {
  const result = await runAgent(
    baseOpts(path.join(fixturesDir, "no-such-entry.js"))
  );
  assert.equal(result.ok, false);
  assert.notEqual(result.exitCode, 0);
});
