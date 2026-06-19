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

// Non-chat / lower-tier families we never want auto-selected as "smartest".
const EXCLUDE_RE = /embedding|aqa|imagen|veo|gemma|learnlm|tts/i;

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
 * Rank ListModels output smartest-first. Keeps only chat models (those whose
 * `supportedGenerationMethods` includes `generateContent`), drops embedding /
 * image / lower-tier families, strips the `models/` prefix, and orders by
 * tier, then version, then name for a stable result.
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
    const ta = tierWeight(a);
    const tb = tierWeight(b);
    if (ta !== tb) return tb - ta;
    const va = versionOf(a);
    const vb = versionOf(b);
    if (va !== vb) return vb > va ? 1 : -1;
    return a.localeCompare(b);
  });
  return uniq;
}

/**
 * Discover the user's Gemini models via the ListModels REST API and return
 * them smartest-first, or null when discovery isn't possible (no key in the
 * server env, no global fetch, network/HTTP error, or an empty result). A null
 * return is the signal to fall back to GEMINI_FALLBACK_MODELS.
 */
export async function listGeminiModels(
  env: NodeJS.ProcessEnv = process.env
): Promise<string[] | null> {
  const key = env.GEMINI_API_KEY;
  if (!key || typeof fetch !== "function") return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LIST_TIMEOUT_MS);
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
