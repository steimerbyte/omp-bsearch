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
  mode?: string;
};

export interface BsearchDetails {
  urls: string[];
  exitCode: number | null;
  mode: "llm" | "web";
}

export interface ParsedSource {
  index: number;
  title: string;
  url: string;
  snippets: string[];
  age?: string;
}

export interface ParsedOutput {
  totalSources: number;
  sources: ParsedSource[];
  rawText: string;
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

function truncate(str: string | undefined, maxLen: number): string {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, Math.max(0, maxLen - 3)) + "...";
}

function formatLlmContext(data: LlmContextResponse, compact = false): string[] {
  const lines: string[] = [];
  const grounding = data.grounding ?? {};
  const sources = data.sources ?? {};
  let totalSnippets = 0;

  if (grounding.poi) {
    const poi = grounding.poi;
    totalSnippets += poi.snippets?.length ?? 0;
    lines.push(`📍 ${poi.name}`);
    lines.push(`   ${poi.url}`);
    for (const s of (poi.snippets ?? []).slice(0, compact ? 1 : 3)) {
      lines.push(`   ${truncate(s, 300)}`);
    }
    lines.push("");
  }

  if (grounding.map && grounding.map.length > 0) {
    lines.push("🗺️  Local Results:");
    grounding.map.slice(0, compact ? 3 : 5).forEach((m, i) => {
      totalSnippets += m.snippets?.length ?? 0;
      lines.push("");
      lines.push(`${i + 1}. ${m.name}`);
      lines.push(`   ${m.url}`);
      for (const s of (m.snippets ?? []).slice(0, compact ? 1 : 2)) {
        lines.push(`   ${truncate(s, 200)}`);
      }
    });
    lines.push("");
  }

  if (grounding.generic && grounding.generic.length > 0) {
    lines.push(`📄 Sources (${grounding.generic.length}):`);
    lines.push("");
    grounding.generic.forEach((item, i) => {
      const snippetCount = item.snippets?.length ?? 0;
      totalSnippets += snippetCount;
      const snippetLimit = compact ? 1 : 3;
      lines.push(`${i + 1}. ${item.title}`);
      lines.push(`   ${item.url}`);
      for (const s of (item.snippets ?? []).slice(0, snippetLimit)) {
        lines.push(`   ${truncate(s, 300)}`);
      }
      if ((item.snippets?.length ?? 0) > snippetLimit) {
        lines.push(`   [+${(item.snippets?.length ?? 0) - snippetLimit} more snippets]`);
      }
      lines.push("");
    });
  } else {
    lines.push("⚠️  No relevant content found for this query.");
    lines.push("");
  }

  lines.push("─".repeat(60));
  lines.push(`Total: ${grounding.generic?.length ?? 0} sources, ~${totalSnippets} snippets`);

  if (Object.keys(sources).length > 0) {
    lines.push("");
    lines.push("📅 Source ages:");
    for (const [, meta] of Object.entries(sources)) {
      const age = meta.age && meta.age.length > 0 ? ` (${meta.age[2] ?? meta.age[0]})` : "";
      lines.push(`   ${meta.hostname}${age}`);
    }
  }

  return lines;
}

function formatWebSearch(data: WebSearchResponse, query: string): string[] {
  const lines: string[] = [];
  const results = data.web?.results ?? [];

  if (results.length === 0) {
    lines.push("No results found");
    return lines;
  }

  lines.push(`[Web Search] Found ${results.length} results for "${query}":`);
  lines.push("");
  results.forEach((r, i) => {
    lines.push(`${i + 1}. ${r.title}`);
    lines.push(`   ${r.url}`);
    if (r.description) lines.push(`   ${truncate(r.description, 250)}`);
    if (r.age) lines.push(`   (${r.age})`);
    lines.push("");
  });

  if (data.web?.total?.results && data.web.total.results > results.length) {
    lines.push(`~${data.web.total.results} total.`);
  }

  return lines;
}

const SOURCE_HEADER_RE = /^(\d+)\.\s+(.+)$/;
const URL_LINE_RE = /^(https?:\/\/\S+)\s*$/;
const SOURCES_HEADER_RE = /^📄\s+Sources\s+\((\d+)\):?\s*$/i;

export function parseBsearchOutput(text: string): ParsedOutput {
  const lines = text.split("\n");
  const sources: ParsedSource[] = [];
  let totalSources = 0;
  let current: ParsedSource | null = null;
  let snippetBuffer: string[] = [];

  const flush = () => {
    if (current) {
      current.snippets = snippetBuffer.map((s) => s.trim()).filter(Boolean);
      sources.push(current);
    }
    current = null;
    snippetBuffer = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();

    const headerMatch = SOURCES_HEADER_RE.exec(trimmed);
    if (headerMatch) {
      flush();
      totalSources = parseInt(headerMatch[1] ?? "0", 10);
      continue;
    }

    const numMatch = SOURCE_HEADER_RE.exec(trimmed);
    if (numMatch) {
      flush();
      current = {
        index: parseInt(numMatch[1] ?? "0", 10),
        title: (numMatch[2] ?? "").trim(),
        url: "",
        snippets: [],
      };
      continue;
    }

    if (current && URL_LINE_RE.test(trimmed)) {
      current.url = trimmed;
      continue;
    }

    if (current && /^\(.+\)$/.test(trimmed)) {
      current.age = trimmed.slice(1, -1);
      continue;
    }

    if (current && trimmed.length > 0) {
      snippetBuffer.push(trimmed);
    }
  }
  flush();

  return { totalSources: totalSources || sources.length, sources, rawText: text };
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

function stripControls(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
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

async function executeBsearch(params: BsearchParams): Promise<AgentToolResult<BsearchDetails>> {
  try {
    const apiKey = await resolveApiKey();
    const mode = params.mode ?? "llm";

    if (mode === "web") {
      const data = await performWebSearch(params, apiKey);
      const lines = formatWebSearch(data, params.query);
      const text = lines.join("\n");
      const urls = extractUrls(text);
      return okResult(text, { urls, exitCode: 0, mode: "web" });
    }
    try {
      const data = await performLlmContext(params, apiKey);
      const lines = formatLlmContext(data, params.compact ?? false);
      const text = lines.join("\n");
      const urls = extractUrls(text);
      return okResult(text, { urls, exitCode: 0, mode: "llm" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("OPTION_NOT_IN_PLAN")) {
        const data = await performWebSearch(params, apiKey);
        const lines = formatWebSearch(data, params.query);
        const text = lines.join("\n");
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
  if (args.mode && args.mode !== "llm") meta.push(`mode=${args.mode}`);
  if (args.count !== undefined) meta.push(`count=${args.count}`);
  if (args.freshness) meta.push(`fresh=${args.freshness}`);
  if (args.country) meta.push(`cc=${args.country.toUpperCase()}`);
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
  const parsed = parseBsearchOutput(text);
  const urls = result.details?.urls ?? [];
  const mode = result.details?.mode ?? "llm";

  const queryLabel = args?.query ? `"${args.query}"` : "web search";
  const headerLine = `Brave Search (${mode}) — ${queryLabel} — ${urls.length} URLs · ${parsed.totalSources} sources`;

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
    mode: Type.Optional(Type.String({ description: "Mode: llm or web" })),
  });

  pi.registerTool({
    name: "brave_better_web_search",
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
