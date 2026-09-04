/**
 * omp-bsearch — Brave Search API as OMP v18 extension tool.
 *
 * Standalone TypeScript implementation. Calls the Brave Search API directly
 * via fetch (no CLI wrapper, no child_process.spawn). Logic ported from
 * github.com/steimerbyte/bsearch-cli/index.js.
 *
 * Renderer policy: take the raw Brave API response JSON, convert it to a
 * clean Markdown string, and push it into a single plain `Text` component.
 * No box frame, no theme-driven sections, no `╭─╮` borders. Sources use the
 * `sources[url]` map's clean `snippet` (NOT the messy
 * `grounding.generic[].snippets[]` chunks) and the first element of
 * `sources[url].age[]` as-is.
 */

import { join } from "node:path";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";

const SETTINGS_PATH = join(homedir(), ".omp", "agent", "settings.json");
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;
const BRAVE_LLM_CONTEXT_URL = "https://api.search.brave.com/res/v1/llm/context";
const BRAVE_WEB_SEARCH_URL = "https://api.search.brave.com/res/v1/web/search";
const DEFAULT_RESULT_COUNT = 5;

interface BsearchSettings {
  braveApiKey?: string;
}

async function loadSettings(): Promise<BsearchSettings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.bsearch?.apiKey) return { braveApiKey: parsed.bsearch.apiKey };
    if (parsed.bsearch?.braveApiKey) return { braveApiKey: parsed.bsearch.braveApiKey };
    if (parsed.braveApiKey) return { braveApiKey: parsed.braveApiKey };
    return {};
  } catch {
    return {};
  }
}

async function resolveApiKey(): Promise<string> {
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;
  const settings = await loadSettings();
  if (settings.braveApiKey) return settings.braveApiKey;
  throw new Error(
    "No Brave API key found. Set BRAVE_API_KEY env var or add bsearch.apiKey to ~/.omp/agent/settings.json.",
  );
}

export type BsearchParams = {
  query: string;
  count?: number;
  freshness?: string;
  offset?: number;
  safesearch?: string;
  max_tokens?: number;
  max_urls?: number;
  threshold?: string;
  country?: string;
  city?: string;
  local?: boolean;
  compact?: boolean;
  timeout?: number;
};

// ─── Relaxed parameter coercion ────────────────────────────────────────────
// The TypeBox schema stays strict (validates user/LLM-supplied JSON), but
// execute() runs every incoming payload through coerceParams() so that any
// malformed value is replaced with a sane fallback / clamped into the
// Brave-documented range BEFORE we hand it to the API. Goal: the search
// always executes, even when the model passes a wildly wrong value.

function coerceNumber(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value < min) return min;
    if (value > max) return max;
    return value;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return fallback;
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) {
      if (parsed < min) return min;
      if (parsed > max) return max;
      return parsed;
    }
  }
  return fallback;
}

function coerceString(value: unknown, maxLen: number): string {
  if (value === undefined || value === null) return "";
  const s = typeof value === "string" ? value : String(value);
  const trimmed = s.trim();
  if (trimmed.length > maxLen) return trimmed.slice(0, maxLen);
  return trimmed;
}

function coerceEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof value !== "string") return fallback;
  const lower = value.toLowerCase();
  return (allowed as readonly string[]).includes(lower) ? (lower as T) : fallback;
}

const VALID_FRESHNESS = /^(pd|pw|pm|py|\d{4}-\d{2}-\d{2}to\d{4}-\d{2}-\d{2})$/;

export function coerceParams(raw: unknown): BsearchParams {
  const r = (raw ?? {}) as Record<string, unknown>;

  const query = coerceString(r.query, 500);

  const count = coerceNumber(r.count, DEFAULT_RESULT_COUNT, 1, 50);
  let offset: number | undefined;
  if (r.offset !== undefined) {
    const n = typeof r.offset === "number" && Number.isFinite(r.offset)
      ? r.offset
      : Number(String(r.offset).trim());
    if (Number.isFinite(n) && n >= 0) {
      offset = n > 1000 ? 1000 : n;
    }
  }

  let freshness: string | undefined;
  if (typeof r.freshness === "string" && VALID_FRESHNESS.test(r.freshness)) {
    freshness = r.freshness;
  }

  const safesearch = coerceEnum(
    r.safesearch,
    ["off", "moderate", "strict"] as const,
    "off",
  );

  const maxTokens = coerceNumber(r.max_tokens, 8192, 1024, 32768);
  const maxUrls = coerceNumber(r.max_urls, DEFAULT_RESULT_COUNT, 1, 50);

  const threshold = coerceEnum(
    r.threshold,
    ["strict", "balanced", "lenient", "disabled"] as const,
    "balanced",
  );

  let country: string | undefined;
  if (typeof r.country === "string" && r.country.length === 2) {
    country = r.country.toLowerCase();
  }

  let city: string | undefined;
  if (typeof r.city === "string" && r.city.length > 0) {
    city = r.city;
  }

  const local = Boolean(r.local);
  const compact = Boolean(r.compact);
  const timeout = coerceNumber(r.timeout, DEFAULT_TOOL_TIMEOUT_MS, 1000, 120000);
  return {
    query,
    count,
    freshness,
    offset,
    safesearch,
    max_tokens: maxTokens,
    max_urls: maxUrls,
    threshold,
    country,
    city,
    local,
    compact,
    timeout,
  };
}

export interface BsearchDetails {
  urls: string[];
  exitCode: number | null;
  mode: "llm" | "web";
  response: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

const HTTP_ERROR_MESSAGES: Record<number, string> = {
  401: "Invalid Brave API key",
  429: "Brave rate limit hit",
  500: "Brave server error",
};

async function fetchWithRetry(
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  retries = 3,
): Promise<Response> {
  let lastError = new Error("All retry attempts failed");

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, { headers, signal: controller.signal });
      clearTimeout(timeoutId);

      if (response.status === 429) {
        if (attempt < retries - 1) {
          const retryAfterHeader = response.headers.get("Retry-After");
          const parsed = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
          const delay = Number.isFinite(parsed) ? parsed : Math.pow(2, attempt + 1);
          await sleep(delay * 1000);
          continue;
        }
        return response;
      }

      return response;
    } catch (err) {
      clearTimeout(timeoutId);
      lastError = err instanceof Error ? err : new Error(String(err));
      if (lastError.name === "AbortError") {
        lastError = new Error(`Request timeout after ${timeoutMs}ms`);
      }
    }
  }

  throw lastError;
}

// Brave LLM Context response shape. Note: `sources[url]` carries the clean
// per-URL fields (title / hostname / age / snippet); `grounding.generic[]`
// is only used to determine display ORDER.
interface LlmContextResponse {
  answer?: string;
  follow_up_questions?: string[];
  grounding?: {
    generic?: Array<{ title: string; url: string; snippets?: string[] }>;
    map?: Array<{ name: string; url: string; snippets?: string[] }>;
    poi?: { name: string; url: string; snippets?: string[] };
  };
  sources?: Record<
    string,
    {
      title?: string;
      hostname?: string;
      age?: string[];
      snippet?: string;
    }
  >;
}

async function performLlmContext(params: BsearchParams, apiKey: string): Promise<LlmContextResponse> {
  const apiUrl = new URL(BRAVE_LLM_CONTEXT_URL);
  apiUrl.searchParams.append("q", params.query);
  apiUrl.searchParams.append("count", String(params.count ?? DEFAULT_RESULT_COUNT));
  apiUrl.searchParams.append("maximum_number_of_tokens", String(params.max_tokens ?? 8192));
  apiUrl.searchParams.append("maximum_number_of_urls", String(params.max_urls ?? DEFAULT_RESULT_COUNT));
  apiUrl.searchParams.append("context_threshold_mode", params.threshold ?? "balanced");

  if (params.local) apiUrl.searchParams.append("enable_local", "true");
  if (params.freshness) apiUrl.searchParams.append("freshness", params.freshness);
  if (params.country) apiUrl.searchParams.append("country", params.country);

  const headers: Record<string, string> = {
    "X-Subscription-Token": apiKey,
    Accept: "application/json",
    "Accept-Encoding": "gzip, deflate",
    "cache-control": "no-cache",
  };

  if (params.country) headers["X-Loc-Country"] = params.country;
  if (params.city) headers["X-Loc-City"] = params.city;

  const response = await fetchWithRetry(apiUrl.toString(), headers, params.timeout ?? DEFAULT_TOOL_TIMEOUT_MS);

  if (!response.ok) {
    try {
      const errorData = (await response.json()) as { error?: { code?: string; detail?: string } };
      if (errorData.error?.code === "OPTION_NOT_IN_PLAN") {
        throw new Error("OPTION_NOT_IN_PLAN");
      }
      const detail = errorData.error?.detail ?? "";
      throw new Error(
        `${HTTP_ERROR_MESSAGES[response.status] ?? `API error ${response.status}`}${detail ? `: ${detail}` : ""}`,
      );
    } catch (e) {
      if (e instanceof Error && e.message === "OPTION_NOT_IN_PLAN") throw e;
      throw new Error(HTTP_ERROR_MESSAGES[response.status] ?? `API error ${response.status}`);
    }
  }

  return (await response.json()) as LlmContextResponse;
}

interface WebSearchResponse {
  web?: {
    results: Array<{
      title: string;
      url: string;
      description?: string;
      extra_snippets?: string[];
      age?: string;
      meta_url?: { hostname?: string; favicon?: string; title?: string };
    }>;
    total?: { results?: number };
  };
}

async function performWebSearch(params: BsearchParams, apiKey: string): Promise<WebSearchResponse> {
  const apiUrl = new URL(BRAVE_WEB_SEARCH_URL);
  apiUrl.searchParams.append("q", params.query);
  apiUrl.searchParams.append("count", String(params.count ?? DEFAULT_RESULT_COUNT));
  apiUrl.searchParams.append("safesearch", params.safesearch ?? "off");
  if (params.offset && params.offset !== 0) apiUrl.searchParams.append("offset", String(params.offset));
  if (params.freshness) apiUrl.searchParams.append("freshness", params.freshness);

  const headers: Record<string, string> = {
    "X-Subscription-Token": apiKey,
    Accept: "application/json",
  };

  const response = await fetchWithRetry(apiUrl.toString(), headers, params.timeout ?? DEFAULT_TOOL_TIMEOUT_MS);

  if (!response.ok) {
    throw new Error(HTTP_ERROR_MESSAGES[response.status] ?? `API error ${response.status}`);
  }

  return (await response.json()) as WebSearchResponse;
}

// ─── Markdown pass-through renderer ────────────────────────────────────────
// Goal: emit one clean Markdown document from the raw Brave response. No
// box frame, no theme, no truncation, no normalization gymnastics. Source
// snippets come from `sources[url].snippet` (clean) — never from the messy
// `grounding.generic[].snippets[]` chunks. Order follows `grounding.generic[]`.

function stripControls(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
}

// Escape characters that would break inline Markdown rendering. We escape
// backslashes first so subsequent replacements aren't re-escaped.
const escapeMarkdownInline = (s: string): string =>
  s.replace(/\\/g, "\\\\").replace(/([|`*_{}[\]<>#!])/g, "\\$1");

// Escape leading blockquote markers so snippets starting with `>` don't
// break list nesting when rendered as Markdown.
const escapeMarkdownBlock = (s: string): string => s.replace(/^(\s*)>/gm, "$1\\>");

export function renderSearchResult(
  mode: "llm" | "web",
  response: unknown,
  args: { query?: string } = {},
): string {
  const isLlm = mode === "llm";
  const lines: string[] = [];
  const title = isLlm ? "Web Search (Brave LLM Context)" : "Web Search (Brave Web Search)";
  lines.push(`# ${title}`);

  if (args.query && args.query.trim().length > 0) {
    lines.push("");
    lines.push("## Query");
    lines.push("");
    lines.push(escapeMarkdownBlock(args.query.trim()));
  }

  if (isLlm) {
    const llmResp = response as LlmContextResponse | undefined;
    const rawAnswer = typeof llmResp?.answer === "string" ? llmResp.answer.trim() : "";
    if (rawAnswer.length > 0) {
      lines.push("");
      lines.push("## Answer");
      lines.push("");
      lines.push(escapeMarkdownBlock(rawAnswer));
    }
  }

  // Sources — ordered per `grounding.generic[]` for LLM mode, or the raw
  // web results array for web mode. We always use the clean
  // `sources[url].snippet` / `sources[url].age` / `sources[url].hostname`.
  const orderedSources = isLlm
    ? collectLlmSources(response)
    : collectWebSources(response);

  lines.push("");
  lines.push("## Sources");
  lines.push("");
  if (orderedSources.length === 0) {
    lines.push("_No sources returned._");
  } else {
    for (const src of orderedSources) {
      const titleText = src.title || src.url || "Untitled";
      const link = `[${escapeMarkdownInline(titleText)}](${src.url})`;
      const metaParts: string[] = [];
      if (src.hostname) metaParts.push(escapeMarkdownInline(src.hostname));
      if (src.age) metaParts.push(escapeMarkdownInline(src.age));
      const metaSuffix = metaParts.length > 0 ? ` — ${metaParts.join(" · ")}` : "";
      lines.push(`- ${link}${metaSuffix}`);
      if (src.snippet) {
        // Indented blockquote per snippet line so the snippet renders as a
        // child of the list bullet without breaking list nesting.
        const escapedSnippet = escapeMarkdownBlock(src.snippet).replace(/\r?\n/g, "\n");
        for (const seg of escapedSnippet.split("\n")) {
          lines.push(`  > ${seg}`);
        }
      }
    }
  }

  // Web mode trailing total line — informational only.
  if (!isLlm) {
    const webResp = response as WebSearchResponse | undefined;
    const total = typeof webResp?.web?.total?.results === "number" ? webResp.web.total.results : undefined;
    if (typeof total === "number" && total > orderedSources.length) {
      lines.push("");
      lines.push(`_…and ${total - orderedSources.length} more results._`);
    }
  }

  return lines.join("\n");
}

interface OrderedSource {
  url: string;
  title: string;
  hostname?: string;
  age?: string;
  snippet?: string;
}

function collectLlmSources(response: unknown): OrderedSource[] {
  const d = response as LlmContextResponse | undefined;
  if (!d) return [];
  const sourcesMap = d.sources ?? {};
  const out: OrderedSource[] = [];
  const seen = new Set<string>();

  for (const g of d.grounding?.generic ?? []) {
    if (!g || typeof g.url !== "string" || g.url.length === 0) continue;
    if (seen.has(g.url)) continue;
    const clean = sourcesMap[g.url];
    if (!clean) continue; // orphan — not in `sources`, skip
    seen.add(g.url);
    const rawAge = Array.isArray(clean.age)
      ? clean.age.find((a) => typeof a === "string" && a.trim().length > 0)
      : undefined;
    out.push({
      url: g.url,
      title: stripControls(clean.title ?? g.title ?? ""),
      hostname: clean.hostname,
      age: rawAge ? rawAge.trim() : undefined,
      snippet: typeof clean.snippet === "string" ? stripControls(clean.snippet) : undefined,
    });
  }
  return out;
}

function collectWebSources(response: unknown): OrderedSource[] {
  const d = response as WebSearchResponse | undefined;
  if (!d?.web?.results) return [];
  const out: OrderedSource[] = [];
  for (const r of d.web.results) {
    const title = typeof r.title === "string" ? stripControls(r.title) : "";
    const description = typeof r.description === "string" ? stripControls(r.description) : undefined;
    const hostname = typeof r.meta_url?.hostname === "string" ? r.meta_url.hostname : undefined;
    const age = typeof r.age === "string" && r.age.trim().length > 0 ? r.age.trim() : undefined;
    out.push({
      url: r.url ?? "",
      title,
      hostname,
      age,
      snippet: description && description.length > 0 ? description : undefined,
    });
  }
  return out;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function okResult(text: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  return {
    content: [textContent(stripControls(text))],
    details,
    isError: false,
  };
}

function errResult(message: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  return {
    content: [textContent(stripControls(message))],
    details,
    isError: true,
  };
}

function extractUrls(text: string): string[] {
  const URL_REGEX = /https?:\/\/[^\s<>"'`]+[^\s<>"'`)\]\}]/g;
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

async function executeBsearch(rawParams: BsearchParams): Promise<AgentToolResult<BsearchDetails>> {
  const params = coerceParams(rawParams);
  try {
    const apiKey = await resolveApiKey();
    try {
      const data = await performLlmContext(params, apiKey);
      const text = renderSearchResult("llm", data, { query: params.query });
      const urls = extractUrls(text);
      return okResult(text, { urls, exitCode: 0, mode: "llm", response: data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("OPTION_NOT_IN_PLAN")) {
        const data = await performWebSearch(params, apiKey);
        const text = renderSearchResult("web", data, { query: params.query });
        const urls = extractUrls(text);
        return okResult(text, { urls, exitCode: 0, mode: "web", response: data });
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errResult(message, { urls: [], exitCode: null, mode: "llm", response: null });
  }
}

export function renderResult(
  result: AgentToolResult<BsearchDetails>,
  _options: { expanded: boolean; isPartial: boolean },
  _theme: Theme,
  args?: BsearchParams,
): Component {
  // Error path — surface the error verbatim, no theme, no box.
  if (result.isError) {
    const msg = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    return new Text(`Error: ${stripControls(msg)}`, 0, 0);
  }

  const mode = result.details?.mode ?? "llm";
  const response = result.details?.response;
  const markdown = renderSearchResult(mode, response, { query: args?.query });
  return new Text(stripControls(markdown), 0, 0);
}

export default function bsearchExtension(pi: ExtensionAPI): void {
  const { Type } = pi.typebox;

  const BsearchParamsSchema = Type.Object({
    query: Type.String({ description: "Search query string" }),
    count: Type.Optional(Type.Number({ description: "Number of search results to consider (1-50)", minimum: 1, maximum: 50 })),
    freshness: Type.Optional(Type.String({ description: "Freshness filter (pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD)" })),
    offset: Type.Optional(Type.Number({ description: "Pagination offset for web search", minimum: 0 })),
    safesearch: Type.Optional(Type.String({ description: "SafeSearch mode (off/moderate/strict)" })),
    max_tokens: Type.Optional(Type.Number({ description: "Max tokens in LLM context (1024-32768)", minimum: 1024, maximum: 32768 })),
    max_urls: Type.Optional(Type.Number({ description: "Max URLs in response (1-50)", minimum: 1, maximum: 50 })),
    threshold: Type.Optional(Type.String({ description: "Context threshold (strict/balanced/lenient/disabled)" })),
    country: Type.Optional(Type.String({ description: "Country code (2 letters)" })),
    city: Type.Optional(Type.String({ description: "City name for location-aware queries" })),
    local: Type.Optional(Type.Boolean({ description: "Force local recall for location-aware queries" })),
    compact: Type.Optional(Type.Boolean({ description: "Compact output (fewer snippets)" })),
    timeout: Type.Optional(Type.Number({ description: "Request timeout in ms", minimum: 1000 })),
  });

  pi.registerTool({
    name: "web_search",
    label: "Brave Web Search",
    description:
      "PRIMARY: Always use this tool for any web search task. Native Brave Search API client (LLM Context + Web Search modes) with retry and timeout. Returns LLM-contextualized, pre-extracted content.",
    parameters: BsearchParamsSchema,
    hidden: false,
    renderResult,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, _ctx) => {
      return executeBsearch(rawParams as BsearchParams);
    },
  });
}
