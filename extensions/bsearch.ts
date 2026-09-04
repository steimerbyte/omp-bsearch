/**
 * omp-bsearch — Brave Search API as OMP v18 extension tool.
 *
 * Standalone TypeScript implementation. Calls the Brave Search API directly
 * via fetch (no CLI wrapper, no child_process.spawn). Logic ported from
 * github.com/steimerbyte/bsearch-cli/index.js.
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
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

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

interface LlmContextResponse {
  grounding?: {
    generic?: Array<{ title: string; url: string; snippets?: string[] }>;
    map?: Array<{ name: string; url: string; snippets?: string[] }>;
    poi?: { name: string; url: string; snippets?: string[] };
  };
  sources?: Record<string, { hostname: string; age?: string[] }>;
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
    results: Array<{ title: string; url: string; description?: string; age?: string }>;
    total?: { results: number };
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

// ─── Table rendering ──────────────────────────────────────────────────────
// `mode` is passed by the caller: "llm" for LLM Context responses,
// "web" for Web Search responses. The function inspects the top-level shape
// of `data` and renders Markdown-style ASCII tables so terminal output stays
// readable. No raw JSON is returned.

type RenderMode = "llm" | "web";

const FIELD_MAX = 80;       // clamp Title/URL/Snippets/Description/Name to this
const COL_MAX = 200;        // hard ceiling on a computed column width
const SNIPPET_SEP = " | ";  // separator between joined snippets

function clamp(s: string, max: number): string {
  if (s.length <= max) return s;
  if (max <= 1) return s.slice(0, max);
  return s.slice(0, max - 1) + "…";
}

function pad(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + " ".repeat(width - s.length);
}

function joinSnippets(snippets: string[] | undefined): string {
  if (!snippets || snippets.length === 0) return "";
  return snippets.map((s) => clamp(stripControls(s), FIELD_MAX)).join(SNIPPET_SEP);
}

interface ColumnSpec {
  header: string;
  width: number;
}

function buildRows(
  rows: string[][],
  headers: string[],
): { spec: ColumnSpec[]; lines: string[] } {
  // Compute column widths: max(header, max(value)) capped to COL_MAX.
  const widths = headers.map((h) => h.length);
  for (const row of rows) {
    for (let i = 0; i < headers.length; i++) {
      const v = row[i] ?? "";
      if (v.length > widths[i]!) widths[i] = v.length;
    }
  }
  const spec: ColumnSpec[] = headers.map((h, i) => ({
    header: h,
    width: Math.min(Math.max(widths[i]!, h.length), COL_MAX),
  }));

  const renderRow = (cells: string[]): string =>
    "| " + spec.map((c, i) => pad(cells[i] ?? "", c.width)).join(" | ") + " |";

  const sep =
    "|" + spec.map((c) => "-".repeat(c.width + 2)).join("|") + "|";

  const lines: string[] = [renderRow(spec.map((c) => c.header)), sep];
  for (const row of rows) lines.push(renderRow(row));
  return { spec, lines };
}

function tableBlock(headers: string[], rows: string[][]): string {
  if (rows.length === 0) return "No results";
  return buildRows(rows, headers).lines.join("\n");
}

function renderLlmContextAsTable(data: unknown): string {
  const d = data as LlmContextResponse;
  const blocks: string[] = [];

  const generic = d.grounding?.generic;
  if (generic && generic.length > 0) {
    const rows = generic.map((g, i) => [
      String(i + 1),
      clamp(stripControls(g.title ?? ""), FIELD_MAX),
      clamp(stripControls(g.url ?? ""), FIELD_MAX),
      joinSnippets(g.snippets),
    ]);
    blocks.push(tableBlock(["#", "Title", "URL", "Snippets"], rows));
  }

  const map = d.grounding?.map;
  if (map && map.length > 0) {
    const rows = map.map((m, i) => [
      String(i + 1),
      clamp(stripControls(m.name ?? ""), FIELD_MAX),
      clamp(stripControls(m.url ?? ""), FIELD_MAX),
      joinSnippets(m.snippets),
    ]);
    if (blocks.length > 0) blocks.push("");
    blocks.push(tableBlock(["#", "Name", "URL", "Snippets"], rows));
  }

  const poi = d.grounding?.poi;
  if (poi) {
    const row = [
      "1",
      clamp(stripControls(poi.name ?? ""), FIELD_MAX),
      clamp(stripControls(poi.url ?? ""), FIELD_MAX),
      joinSnippets(poi.snippets),
    ];
    if (blocks.length > 0) blocks.push("");
    blocks.push(tableBlock(["#", "Name", "URL", "Snippets"], [row]));
  }

  const sources = d.sources;
  if (sources) {
    const entries = Object.entries(sources);
    if (entries.length > 0) {
      const rows = entries.map(([url, src], i) => [
        String(i + 1),
        clamp(stripControls(src.hostname ?? ""), FIELD_MAX),
        clamp(stripControls(url), FIELD_MAX),
        clamp(stripControls((src.age ?? []).join(", ")), FIELD_MAX),
      ]);
      if (blocks.length > 0) blocks.push("");
      blocks.push(tableBlock(["#", "Hostname", "URL", "Age"], rows));
    }
  }

  return blocks.length > 0 ? blocks.join("\n") : "No results";
}

function renderWebSearchAsTable(data: unknown): string {
  const d = data as WebSearchResponse;
  const results = d.web?.results ?? [];
  if (results.length === 0) return "No results";

  const rows = results.map((r, i) => [
    String(i + 1),
    clamp(stripControls(r.title ?? ""), FIELD_MAX),
    clamp(stripControls(r.url ?? ""), FIELD_MAX),
    clamp(stripControls(r.description ?? ""), FIELD_MAX),
    clamp(stripControls(r.age ?? ""), FIELD_MAX),
  ]);

  const block = tableBlock(["#", "Title", "URL", "Description", "Age"], rows);
  const total = d.web?.total?.results;
  const totalHint =
    typeof total === "number" ? `\n\nTotal results reported by Brave: ${total}` : "";
  return block + totalHint;
}

export function renderApiResponseAsTable(data: unknown, mode: RenderMode): string {
  if (mode === "web") return renderWebSearchAsTable(data);
  return renderLlmContextAsTable(data);
}


function textContent(text: string): TextContent {
  return { type: "text", text };
}

function stripControls(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
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
      const text = renderApiResponseAsTable(data, "llm");
      const urls = extractUrls(text);
      return okResult(text, { urls, exitCode: 0, mode: "llm" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("OPTION_NOT_IN_PLAN")) {
        const data = await performWebSearch(params, apiKey);
        const text = renderApiResponseAsTable(data, "web");
        const urls = extractUrls(text);
        return okResult(text, { urls, exitCode: 0, mode: "web" });
      }
      throw err;
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return errResult(message, { urls: [], exitCode: null, mode: "llm" });
  }
}

export function renderCall(
  args: BsearchParams,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const q = stripControls(args.query ?? "");
  const meta: string[] = [];
  if (args.count !== undefined) meta.push(`count=${args.count}`);
  if (args.freshness) meta.push(`fresh=${args.freshness}`);
  if (args.city) meta.push(`city=${args.city}`);
  if (args.local) meta.push("local");
  const metaSuffix = meta.length > 0 ? " " + theme.fg("muted", meta.join(" ")) : "";
  const line = `${theme.fg("toolTitle", theme.bold("Brave Search"))} ${theme.fg("accent", `"${q}"`)}${metaSuffix}`;
  return new Text(line, 0, 0);
}

const COLLAPSED_MAX_LINES = 80;

export function renderResult(
  result: AgentToolResult<BsearchDetails>,
  options: ToolRenderResultOptions,
  _theme: Theme,
  args?: BsearchParams,
): Component {
  if (result.isError) {
    const msg = result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
    return new Text(`✗ ${msg}`, 0, 0);
  }

  const textBlock = result.content.find((c) => c.type === "text");
  const text = (textBlock && "text" in textBlock ? textBlock.text : "") ?? "";
  const urls = result.details?.urls ?? [];
  const mode = result.details?.mode ?? "llm";

  const queryLabel = args?.query ? `"${args.query}"` : "web search";
  const headerLine = `Brave Search (${mode}) — ${queryLabel} — ${urls.length} URLs`;

  const allLines = text.split("\n");
  let bodyLines = allLines;

  if (!options.expanded && allLines.length > COLLAPSED_MAX_LINES) {
    bodyLines = allLines.slice(0, COLLAPSED_MAX_LINES);
    bodyLines.push(`   [+${allLines.length - COLLAPSED_MAX_LINES} more lines]`);
  }

  return new Text([headerLine, ...bodyLines].join("\n"), 0, 0);
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
    renderCall,
    renderResult,
    execute: async (_toolCallId, rawParams, _signal, _onUpdate, _ctx) => {
      return executeBsearch(rawParams as BsearchParams);
    },
  });
}
