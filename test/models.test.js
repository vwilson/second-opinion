import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_SAFETY_NET,
  listGeminiModels,
  rankGeminiModels,
  SAFE_MODEL_RE,
} from "../dist/models.js";
import { AGENTS, rememberModel } from "../dist/registry.js";

// build a ListModels-shaped entry; defaults to a chat-capable model
const m = (name, methods = ["generateContent"]) => ({
  name,
  supportedGenerationMethods: methods,
});

const agent = (name) => {
  const found = AGENTS.find((a) => a.name === name);
  assert.ok(found, `agent ${name} exists`);
  return found;
};

// ---- rankGeminiModels ----------------------------------------------------

test("rankGeminiModels orders by tier, then version, latest-first", () => {
  const models = [
    m("models/gemini-2.5-flash"),
    m("models/gemini-2.5-pro"),
    m("models/gemini-2.5-flash-lite"),
    m("models/gemini-2.0-flash"),
    m("models/gemini-1.5-pro"),
    m("models/gemini-pro-latest"),
  ];
  assert.deepEqual(rankGeminiModels(models), [
    "gemini-pro-latest", // pro, latest → top
    "gemini-2.5-pro", // pro, 2.5
    "gemini-1.5-pro", // pro, 1.5
    "gemini-2.5-flash", // flash, 2.5
    "gemini-2.0-flash", // flash, 2.0
    "gemini-2.5-flash-lite", // flash-lite
  ]);
});

test("rankGeminiModels drops embedding / aqa / non-chat models", () => {
  const models = [
    m("models/gemini-2.5-pro"),
    m("models/embedding-001", ["embedContent"]),
    m("models/text-embedding-004", []),
    m("models/aqa", ["generateAnswer"]),
    // chat-shaped name but lacks generateContent → excluded
    m("models/gemini-vision-only", ["embedContent"]),
  ];
  assert.deepEqual(rankGeminiModels(models), ["gemini-2.5-pro"]);
});

test("rankGeminiModels ignores malformed entries and unsafe ids", () => {
  const models = [
    m("models/gemini-2.5-pro"),
    m("models/--sneaky-flag"),
    { name: 123 },
    {},
    null,
  ];
  assert.deepEqual(rankGeminiModels(models), ["gemini-2.5-pro"]);
});

// ---- listGeminiModels ----------------------------------------------------

test("listGeminiModels returns null with no API key (no network)", async () => {
  assert.equal(await listGeminiModels({}), null);
});

// ---- SAFE_MODEL_RE -------------------------------------------------------

test("SAFE_MODEL_RE accepts real ids, rejects flag-smuggling", () => {
  const valid = [
    "gemini-2.5-pro",
    "claude-opus-4-8",
    "gpt-5-codex",
    "models/x.y_z",
  ];
  for (const id of valid) assert.ok(SAFE_MODEL_RE.test(id), id);
  for (const bad of ["--yolo", "-m", " spaced", ""]) {
    assert.ok(!SAFE_MODEL_RE.test(bad), bad);
  }
});

// ---- gemini availability matcher ----------------------------------------

test("gemini.isModelUnavailable: tier-gate and not-found", () => {
  const g = agent("gemini");
  assert.equal(
    g.isModelUnavailable({
      output: "",
      stderrTail: "429 ... Quota exceeded ... limit: 0, model: gemini-2.5-pro",
    }),
    true
  );
  assert.equal(
    g.isModelUnavailable({
      output: "",
      stderrTail: "models/gemini-9 is not found for API version v1beta",
    }),
    true
  );
});

test("gemini.isModelUnavailable: keeps model on transient 429 / auth", () => {
  const g = agent("gemini");
  // a real per-minute rate limit has a non-zero limit — keep the model
  assert.equal(
    g.isModelUnavailable({
      output: "",
      stderrTail: "429 RESOURCE_EXHAUSTED ... limit: 250 per minute",
    }),
    false
  );
  assert.equal(
    g.isModelUnavailable({
      output: "",
      stderrTail: "API key not valid. Please pass a valid API key.",
    }),
    false
  );
});

// ---- claude availability matcher ----------------------------------------

test("claude.isModelUnavailable: disabled and unknown models", () => {
  const c = agent("claude");
  // captured live while Fable was globally disabled
  assert.equal(
    c.isModelUnavailable({
      output: "Claude Fable 5 is currently unavailable. Learn more: ...",
      stderrTail: "",
    }),
    true
  );
  assert.equal(
    c.isModelUnavailable({ output: "", stderrTail: 'unknown model "foo"' }),
    true
  );
});

test("claude.isModelUnavailable: a normal answer is available", () => {
  const c = agent("claude");
  assert.equal(c.isModelUnavailable({ output: "OK", stderrTail: "" }), false);
});

// ---- resolveModels (override + cache, no network) ------------------------

test("resolveModels: explicit model collapses the chain", async () => {
  assert.deepEqual(await agent("claude").resolveModels("claude-opus-4-8"), [
    "claude-opus-4-8",
  ]);
  // requested short-circuits before any Gemini discovery
  assert.deepEqual(await agent("gemini").resolveModels("gemini-2.5-flash"), [
    "gemini-2.5-flash",
  ]);
});

test("claude.resolveModels: Fable then Opus, cached winner", async () => {
  const c = agent("claude");
  assert.deepEqual(await c.resolveModels(undefined), [
    "claude-fable-5",
    "claude-opus-4-8",
  ]);
  // simulate a prior call that fell through to Opus (Fable disabled)
  rememberModel("claude", "claude-opus-4-8");
  assert.deepEqual(await c.resolveModels(undefined), [
    "claude-opus-4-8",
    "claude-fable-5",
  ]);
});

test("codex.resolveModels defaults to the CLI flagship (no -m)", async () => {
  assert.deepEqual(await agent("codex").resolveModels(undefined), [undefined]);
});

test("the Gemini safety-net model is free-tier reachable", () => {
  assert.equal(GEMINI_SAFETY_NET, "gemini-2.5-flash");
});
