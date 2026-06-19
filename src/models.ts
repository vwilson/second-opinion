import process from "node:process";

// A plain model id: letters/digits then the punctuation real ids use. Shared
// by the tool's `model` input validation and the Gemini discovery path so a
// model name coming off the network can't smuggle a leading-dash CLI flag
// (e.g. `--yolo`) into the spawned argv.
export const SAFE_MODEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

// Used when ListModels can't run (no GEMINI_API_KEY in the server env — e.g.
// the README's OAuth-only setup — or the call failed). The `-latest` aliases
// auto-track the current generation server-side (Google hot-swaps them on each
// release, with notice), so no-key users still reach the newest pro/flash
// without this list being updated; the concrete 2.5 ids are the floor if a
// `-latest` alias isn't reachable on the caller's tier.
export const GEMINI_FALLBACK_MODELS = [
  "gemini-pro-latest",
  "gemini-flash-latest",
  "gemini-2.5-pro",
  "gemini-2.5-flash",
];

// Always reachable on a free-tier key — appended last so the candidate chain
// can never dead-end on tier-gated models.
export const GEMINI_SAFETY_NET = "gemini-2.5-flash";

const GEMINI_LIST_URL =
  "https://generativelanguage.googleapis.com/v1beta/models";
const LIST_TIMEOUT_MS = 10_000;

// Non-chat / lower-tier families we never want auto-selected as a coding model.
// `image` covers both `imagen-*` and image-output chat ids like
// `gemini-2.5-flash-image` (a.k.a. "Nano Banana"), which still expose
// generateContent but are not coding/chat models.
const EXCLUDE_RE = /embedding|aqa|image|veo|gemma|learnlm|tts|nano-banana/i;

interface GeminiModelInfo {
  name?: unknown;
  supportedGenerationMethods?: unknown;
}

/** pro > flash > flash-lite; anything else is unranked. */
function tierWeight(id: string): number {
  if (/flash-lite/i.test(id)) return 1;
  if (/flash/i.test(id)) return 2;
  if (/pro/i.test(id)) return 3;
  return 0;
}

/**
 * A comparable version number. `-latest` aliases track the newest release, so
 * they sort above any concrete version within the same tier (Infinity), while
 * unversioned ids sort last (0).
 */
function versionOf(id: string): number {
  if (/-latest\b/i.test(id)) return Number.POSITIVE_INFINITY;
  // major with optional minor, anchored to the gemini- family prefix: a
  // single-digit generation (gemini-3-pro) must outrank gemini-2.5, and stray
  // digits elsewhere (gemini-exp-1206) must not masquerade as a huge version
  const m = id.match(/gemini-(\d+)(?:\.(\d+))?/i);
  return m ? Number(m[1]) + Number(m[2] ?? 0) / 10 : 0;
}

/**
 * A recency key for dated previews, so the newest preview of a tied
 * generation/tier wins (e.g. `...-preview-12-2025` over `...-preview-09-2025`).
 * 0 means "no date" (a stable GA id), which is preferred over any preview.
 */
function previewDateKey(id: string): number {
  const my = id.match(/-(\d{2})-(\d{4})\b/); // MM-YYYY (current preview shape)
  if (my) return Number(my[2]) * 100 + Number(my[1]);
  const ymd = id.match(/-(\d{4})-(\d{2})-(\d{2})\b/); // YYYY-MM-DD
  if (ymd) {
    return Number(ymd[1]) * 10000 + Number(ymd[2]) * 100 + Number(ymd[3]);
  }
  const num = id.match(/-(\d{4,})\b/); // trailing date-ish run (e.g. MMDD)
  return num ? Number(num[1]) : 0;
}

/**
 * Rank ListModels output smartest-first. Keeps only chat models (those whose
 * `supportedGenerationMethods` includes `generateContent`), drops embedding /
 * image / lower-tier families, strips the `models/` prefix, and orders by
 * generation (version) first, then tier, then name. Generation leads tier so a
 * newer family wins regardless of tier — Google markets the current Flash as
 * its strongest coding model, so an older Pro must not outrank a newer Flash;
 * tier only breaks ties within the same generation (Pro as the flagship).
 */
export function rankGeminiModels(models: readonly GeminiModelInfo[]): string[] {
  const ids: string[] = [];
  for (const m of models) {
    const name = typeof m?.name === "string" ? m.name : "";
    const id = name.replace(/^models\//, "");
    if (!id || !SAFE_MODEL_RE.test(id) || EXCLUDE_RE.test(id)) continue;
    const methods = m?.supportedGenerationMethods;
    // when the field is present it must allow generateContent; when absent
    // (some responses omit it) keep the model rather than guess it out
    if (Array.isArray(methods) && !methods.includes("generateContent")) {
      continue;
    }
    ids.push(id);
  }

  const uniq = [...new Set(ids)];
  uniq.sort((a, b) => {
    const va = versionOf(a);
    const vb = versionOf(b);
    if (va !== vb) return vb > va ? 1 : -1;
    const ta = tierWeight(a);
    const tb = tierWeight(b);
    if (ta !== tb) return tb - ta;
    const da = previewDateKey(a);
    const db = previewDateKey(b);
    // a stable (undated) id beats any preview; among previews, newest first
    if ((da === 0) !== (db === 0)) return da === 0 ? -1 : 1;
    if (da !== db) return db - da;
    return a.localeCompare(b);
  });
  return uniq;
}

/**
 * Cap the discovered candidate list so the first call doesn't probe every
 * tier-gated model, while guaranteeing the best Flash survives the cap: on a
 * free-tier key the leading Pro candidates fail with `limit: 0`, and without
 * this the chain would skip a discovered current Flash (e.g. gemini-3.5-flash)
 * and fall straight to the hard-coded 2.5 safety net.
 */
export function geminiProbeList(ranked: string[], cap = 4): string[] {
  const base = ranked.slice(0, cap);
  const bestFlash = ranked.find(
    (id) => /flash/i.test(id) && !/flash-lite/i.test(id)
  );
  if (bestFlash && !base.includes(bestFlash)) base.push(bestFlash);
  return base;
}

/**
 * Discover the user's Gemini models via the ListModels REST API and return
 * them smartest-first, or null when discovery isn't possible (no key in the
 * server env, no global fetch, network/HTTP error, or an empty result). A null
 * return is the signal to fall back to GEMINI_FALLBACK_MODELS. `budgetMs` caps
 * the request so discovery can't exceed the call's remaining timeout budget.
 */
export async function listGeminiModels(
  env: NodeJS.ProcessEnv = process.env,
  budgetMs: number = LIST_TIMEOUT_MS
): Promise<string[] | null> {
  const key = env.GEMINI_API_KEY;
  if (!key || typeof fetch !== "function") return null;

  const timeoutMs = Math.max(0, Math.min(LIST_TIMEOUT_MS, budgetMs));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${GEMINI_LIST_URL}?pageSize=200&key=${encodeURIComponent(key)}`;
    const resp = await fetch(url, { signal: controller.signal });
    if (!resp.ok) return null;
    const data = (await resp.json()) as { models?: unknown } | null;
    const list = data?.models;
    const raw = Array.isArray(list) ? (list as GeminiModelInfo[]) : [];
    const ranked = rankGeminiModels(raw);
    return ranked.length ? ranked : null;
  } catch {
    // unreachable host, abort, malformed JSON — degrade to the curated list
    return null;
  } finally {
    clearTimeout(timer);
  }
}
