import assert from "node:assert/strict";
import test from "node:test";

import {
  GEMINI_SAFETY_NET,
  geminiProbeList,
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

test("rankGeminiModels orders by generation, then tier, latest-first", () => {
  const models = [
    m("models/gemini-2.5-flash"),
    m("models/gemini-2.5-pro"),
    m("models/gemini-2.5-flash-lite"),
    m("models/gemini-2.0-flash"),
    m("models/gemini-1.5-pro"),
    m("models/gemini-pro-latest"),
  ];
  assert.deepEqual(rankGeminiModels(models), [
    "gemini-pro-latest", // latest → newest generation
    "gemini-2.5-pro", // gen 2.5, pro
    "gemini-2.5-flash", // gen 2.5, flash
    "gemini-2.5-flash-lite", // gen 2.5, flash-lite
    "gemini-2.0-flash", // gen 2.0
    "gemini-1.5-pro", // gen 1.5
  ]);
});

test("rankGeminiModels drops embedding / aqa / image / non-chat models", () => {
  const models = [
    m("models/gemini-2.5-pro"),
    m("models/embedding-001", ["embedContent"]),
    m("models/text-embedding-004", []),
    m("models/aqa", ["generateAnswer"]),
    // image-output model: uses generateContent but isn't a coding model
    m("models/gemini-2.5-flash-image"),
    m("models/imagen-4.0-generate"),
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

test("rankGeminiModels: a newer Flash outranks an older Pro", () => {
  const models = [
    m("models/gemini-2.5-pro"),
    m("models/gemini-3-pro-preview"), // single-major generation
    m("models/gemini-2.5-flash"),
    m("models/gemini-3.5-flash"), // newest generation, Flash tier
  ];
  assert.deepEqual(rankGeminiModels(models), [
    "gemini-3.5-flash", // gen 3.5 wins regardless of tier
    "gemini-3-pro-preview", // gen 3.0
    "gemini-2.5-pro", // gen 2.5, pro before flash
    "gemini-2.5-flash", // gen 2.5, flash
  ]);
});

test("geminiProbeList keeps the best Flash past the probe cap", () => {
  // four newer Pro variants ahead of the current Flash
  const ranked = [
    "gemini-3.6-pro",
    "gemini-3.6-pro-preview",
    "gemini-3.5-pro",
    "gemini-3.5-pro-exp",
    "gemini-3.5-flash",
  ];
  const got = geminiProbeList(ranked);
  assert.ok(got.includes("gemini-3.5-flash"), "best Flash survives the cap");
  assert.ok(got.length <= 5);
});

test("geminiProbeList prefers a full Flash over flash-lite", () => {
  const got = geminiProbeList([
    "gemini-9-pro",
    "gemini-9-pro-a",
    "gemini-9-pro-b",
    "gemini-9-pro-c",
    "gemini-9-flash-lite",
    "gemini-9-flash",
  ]);
  assert.ok(got.includes("gemini-9-flash"), "the non-lite Flash is preserved");
});

test("rankGeminiModels: newest dated preview of a tied family wins", () => {
  const models = [
    m("models/gemini-2.5-flash-preview-09-2025"),
    m("models/gemini-2.5-flash-preview-12-2025"),
  ];
  assert.deepEqual(rankGeminiModels(models), [
    "gemini-2.5-flash-preview-12-2025", // newer, not ascending-name order
    "gemini-2.5-flash-preview-09-2025",
  ]);
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

test("claude.isModelUnavailable: a service outage is not a downgrade", () => {
  const c = agent("claude");
  // a service/account-level outage must surface, not silently downgrade
  assert.equal(
    c.isModelUnavailable({
      output: "",
      stderrTail: "Error: Service is currently unavailable (503)",
    }),
    false
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

test("claude.resolveModels: Fable, Opus, then the CLI default", async () => {
  const c = agent("claude");
  // the trailing `undefined` (no --model) keeps lower-tier accounts working
  assert.deepEqual(await c.resolveModels(undefined), [
    "claude-fable-5",
    "claude-opus-4-8",
    undefined,
  ]);
  // simulate a prior call that fell through to Opus (Fable disabled)
  rememberModel("claude", "claude-opus-4-8");
  assert.deepEqual(await c.resolveModels(undefined), [
    "claude-opus-4-8",
    "claude-fable-5",
    undefined,
  ]);
});

test("codex.resolveModels defaults to the CLI flagship (no -m)", async () => {
  assert.deepEqual(await agent("codex").resolveModels(undefined), [undefined]);
});

test("copilot.resolveModels defaults to a single 'auto' candidate", async () => {
  assert.deepEqual(await agent("copilot").resolveModels(undefined), ["auto"]);
});

test("copilot.resolveModels: explicit model collapses the chain", async () => {
  assert.deepEqual(await agent("copilot").resolveModels("gpt-5.4"), [
    "gpt-5.4",
  ]);
});

test("copilot.isModelUnavailable is always false (no fallback)", () => {
  const c = agent("copilot");
  assert.equal(
    c.isModelUnavailable({ output: "", stderrTail: "anything at all" }),
    false
  );
});

test("the Gemini safety-net model is free-tier reachable", () => {
  assert.equal(GEMINI_SAFETY_NET, "gemini-2.5-flash");
});

test("SECOND_OPINION_<AGENT>_MODEL: unsafe value is ignored", async () => {
  const c = agent("claude");
  process.env.SECOND_OPINION_CLAUDE_MODEL = "--yolo";
  try {
    const got = await c.resolveModels(undefined);
    assert.ok(!got.includes("--yolo"), "unsafe override must not reach argv");
  } finally {
    delete process.env.SECOND_OPINION_CLAUDE_MODEL;
  }
});

test("SECOND_OPINION_<AGENT>_MODEL: a valid value pins the model", async () => {
  const c = agent("claude");
  process.env.SECOND_OPINION_CLAUDE_MODEL = "claude-sonnet-4-6";
  try {
    assert.deepEqual(await c.resolveModels(undefined), ["claude-sonnet-4-6"]);
  } finally {
    delete process.env.SECOND_OPINION_CLAUDE_MODEL;
  }
});
