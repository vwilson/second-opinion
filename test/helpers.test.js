import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  cleanGeminiOutput,
  FILE_HEAD_BYTES,
  FILE_READ_CAP,
  FILE_TAIL_BYTES,
  makeStreamCollector,
  readFileCapped,
  STREAM_HEAD_CAP,
  STREAM_TAIL_CAP,
  stripAnsi,
  truncateMiddle,
} from "../dist/agents.js";

test("stripAnsi removes CSI sequences", () => {
  assert.equal(stripAnsi("\x1B[31mred\x1B[0m plain"), "red plain");
  assert.equal(stripAnsi("\x1B[1;38;5;208mbold\x1B[m"), "bold");
});

test("stripAnsi removes OSC sequences (BEL- and ST-terminated)", () => {
  assert.equal(stripAnsi("\x1B]0;window title\x07rest"), "rest");
  assert.equal(stripAnsi("\x1B]8;;https://x.test\x1B\\link"), "link");
});

test("stripAnsi leaves an unterminated OSC intact", () => {
  // an OSC cut off by the stream cap (or quoted by the agent) must not
  // swallow real output through to the next BEL/ST
  const s = "\x1B]0;title with no terminator, then real output";
  assert.equal(stripAnsi(s), s);
});

test("stripAnsi removes two-character ESC sequences", () => {
  assert.equal(stripAnsi("\x1BMtext"), "text");
});

test("truncateMiddle passes short strings through", () => {
  assert.equal(truncateMiddle("hello"), "hello");
  const exactlyMax = "x".repeat(100);
  assert.equal(truncateMiddle(exactlyMax, 100), exactlyMax);
});

test("truncateMiddle keeps head and tail and reports omitted count", () => {
  const s = "H".repeat(60) + "M".repeat(100) + "T".repeat(60);
  const out = truncateMiddle(s, 100);
  // headLen = 40% of max, tailLen = the rest
  assert.ok(out.startsWith("H".repeat(40)));
  assert.ok(out.endsWith("T".repeat(60)));
  assert.match(out, /\[\.\.\. 120 characters omitted \.\.\.\]/);
});

test("stream collector returns input verbatim while under the caps", () => {
  const col = makeStreamCollector();
  col.push("hello ");
  col.push("world");
  assert.equal(col.read(), "hello world");
});

test("stream collector splits a chunk straddling the head cap without loss", () => {
  const col = makeStreamCollector();
  col.push("a".repeat(STREAM_HEAD_CAP - 10));
  col.push("b".repeat(30)); // 10 chars fit in head, 20 overflow to tail
  const out = col.read();
  assert.equal(out.length, STREAM_HEAD_CAP + 20);
  assert.equal(out, "a".repeat(STREAM_HEAD_CAP - 10) + "b".repeat(30));
});

test("stream collector drops the middle, keeps head and tail", () => {
  const col = makeStreamCollector();
  col.push("S".repeat(STREAM_HEAD_CAP));
  const chunk = 500_000;
  const rounds = Math.ceil((STREAM_TAIL_CAP * 2) / chunk);
  for (let i = 0; i < rounds; i++) col.push(String(i % 10).repeat(chunk));
  col.push("THE-VERY-END");
  const out = col.read();
  assert.ok(out.startsWith("S".repeat(1000)));
  assert.ok(out.endsWith("THE-VERY-END"));
  assert.match(out, /\[\.\.\. \d+ characters dropped \.\.\.\]/);
  // bounded: never much more than head + tail + marker
  assert.ok(out.length < STREAM_HEAD_CAP + STREAM_TAIL_CAP + chunk + 100);
});

test("readFileCapped reads small files exactly", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentmcp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "small.txt");
  await writeFile(file, "exact content\nwith lines\n");
  assert.equal(await readFileCapped(file), "exact content\nwith lines\n");
});

test("readFileCapped returns head + tail for oversized files", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agentmcp-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "big.txt");
  const size = FILE_READ_CAP + 1_000;
  const buf = Buffer.alloc(size, "m".charCodeAt(0));
  buf.write("HEAD-MARKER", 0);
  buf.write("TAIL-MARKER", size - "TAIL-MARKER".length);
  await writeFile(file, buf);

  const out = await readFileCapped(file);
  assert.ok(out.startsWith("HEAD-MARKER"));
  assert.ok(out.endsWith("TAIL-MARKER"));
  const omitted = size - FILE_HEAD_BYTES - FILE_TAIL_BYTES;
  assert.ok(out.includes(`[... ${omitted} bytes omitted ...]`));
  assert.ok(out.length < FILE_HEAD_BYTES + FILE_TAIL_BYTES + 100);
});

test("cleanGeminiOutput strips known noise lines and trims", () => {
  const stdout = [
    "Loaded cached credentials.",
    "Warning: 256-color support not detected. Colors may not render.",
    "Ripgrep is not available. Falling back to GrepTool.",
    "",
    "The actual answer.",
    "",
  ].join("\n");
  assert.equal(cleanGeminiOutput(stdout), "The actual answer.");
});

test("cleanGeminiOutput keeps lines that merely contain noise text", () => {
  const line = "Note: it printed 'Loaded cached credentials.' mid-sentence";
  assert.equal(cleanGeminiOutput(line), line);
});
