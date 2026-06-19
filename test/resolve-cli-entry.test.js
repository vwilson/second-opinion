import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveCliEntry } from "../dist/agents.js";

const isWindows = process.platform === "win32";

// resolveCliEntry caches by env var name, so every test uses a unique one
let envVarCounter = 0;
function uniqueEnvVar() {
  return `SECOND_OPINION_TEST_ENTRY_${process.pid}_${envVarCounter++}`;
}

async function makeTempDir(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "second-opinion-resolve-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

function withPath(t, dirs) {
  const original = process.env.PATH;
  process.env.PATH = dirs.join(path.delimiter);
  t.after(() => {
    process.env.PATH = original;
  });
}

test("env override wins when the file exists", async (t) => {
  const dir = await makeTempDir(t);
  const entry = path.join(dir, "entry.js");
  await writeFile(entry, "// stub\n");
  const envVar = uniqueEnvVar();
  process.env[envVar] = entry;
  t.after(() => {
    delete process.env[envVar];
  });

  assert.equal(resolveCliEntry("whatever", ["pkg/bin/cli.js"], envVar), entry);
});

test("env override pointing at a missing file throws", async (t) => {
  const envVar = uniqueEnvVar();
  process.env[envVar] = path.join(
    os.tmpdir(),
    "second-opinion-does-not-exist.js"
  );
  t.after(() => {
    delete process.env[envVar];
  });

  assert.throws(
    () => resolveCliEntry("whatever", ["pkg/bin/cli.js"], envVar),
    new RegExp(envVar)
  );
});

test("throws a helpful error when nothing is found", async (t) => {
  const empty = await makeTempDir(t);
  withPath(t, [empty]);
  const envVar = uniqueEnvVar();

  assert.throws(
    () =>
      resolveCliEntry(
        "second-opinion-no-such-cli",
        ["second-opinion-no-such-pkg/bin/cli.js"],
        envVar
      ),
    (err) => {
      assert.match(err.message, /second-opinion-no-such-cli/);
      assert.match(err.message, new RegExp(envVar));
      assert.match(err.message, /second-opinion-no-such-pkg\/bin\/cli\.js/);
      return true;
    }
  );
});

if (isWindows) {
  test("windows: finds the entry beside the .cmd shim's node_modules", async (t) => {
    const bin = await makeTempDir(t);
    const entry = path.join(bin, "node_modules", "fake-pkg", "bin", "cli.js");
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");
    await writeFile(path.join(bin, "fake-cli.cmd"), "@echo off\n");
    withPath(t, [bin]);

    assert.equal(
      resolveCliEntry("fake-cli", ["fake-pkg/bin/cli.js"], uniqueEnvVar()),
      entry
    );
  });

  test("windows: a shim with no adjacent node_modules is not enough", async (t) => {
    const bin = await makeTempDir(t);
    await writeFile(path.join(bin, "fake-cli.cmd"), "@echo off\n");
    withPath(t, [bin]);

    assert.throws(() =>
      resolveCliEntry("fake-cli", ["fake-pkg/bin/cli.js"], uniqueEnvVar())
    );
  });
} else {
  test("posix: resolves the npm bin symlink to the package entry", async (t) => {
    const prefix = await makeTempDir(t);
    const bin = path.join(prefix, "bin");
    const entry = path.join(
      prefix,
      "lib",
      "node_modules",
      "fake-pkg",
      "bin",
      "cli.js"
    );
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");
    await symlink(entry, path.join(bin, "fake-cli"));
    withPath(t, [bin]);

    const resolved = resolveCliEntry(
      "fake-cli",
      ["fake-pkg/bin/cli.js"],
      uniqueEnvVar()
    );
    // realpath may expand tmpdir symlinks (e.g. /tmp -> /private/tmp on
    // macOS), so compare suffixes rather than absolute paths
    assert.ok(
      resolved.endsWith(path.join("node_modules", "fake-pkg", "bin", "cli.js"))
    );
  });

  test("posix: a symlink to JS outside the expected package is rejected", async (t) => {
    const prefix = await makeTempDir(t);
    const bin = path.join(prefix, "bin");
    const impostor = path.join(prefix, "elsewhere", "cli.js");
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(impostor), { recursive: true });
    await writeFile(impostor, "// impostor\n");
    await symlink(impostor, path.join(bin, "fake-cli"));
    withPath(t, [bin]);

    assert.throws(() =>
      resolveCliEntry("fake-cli", ["fake-pkg/bin/cli.js"], uniqueEnvVar())
    );
  });

  test("posix: falls back to the <prefix>/lib/node_modules layout", async (t) => {
    const prefix = await makeTempDir(t);
    const bin = path.join(prefix, "bin");
    const entry = path.join(
      prefix,
      "lib",
      "node_modules",
      "fake-pkg",
      "bin",
      "cli.js"
    );
    await mkdir(bin, { recursive: true });
    await mkdir(path.dirname(entry), { recursive: true });
    await writeFile(entry, "// stub\n");
    // a plain-file shim (not a symlink), like some wrapper scripts
    await writeFile(path.join(bin, "fake-cli"), "#!/bin/sh\n");
    withPath(t, [bin]);

    assert.equal(
      resolveCliEntry("fake-cli", ["fake-pkg/bin/cli.js"], uniqueEnvVar()),
      entry
    );
  });
}
