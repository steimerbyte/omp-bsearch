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
const DEFAULT_RENDER_WIDTH = 100;

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

interface LlmContextResponse {
  answer?: string;
  follow_up_questions?: string[];
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

// ─── Native-style sectioned rendering ────────────────────────────────────
// Mirrors the layout used by the native `@oh-my-pi` web_search renderer:
// header status line → Query / Answer / Sources / Metadata sections, all
// wrapped in a rounded box frame. No pipe tables. All helpers are pure
// string builders so they work without importing omp's internal pi-tui.


export function truncateToWidth(text: string, maxWidth: number): string {
	if (maxWidth <= 0) return "";
	if (text.length <= maxWidth) return text;
	if (maxWidth <= 1) return text.slice(0, maxWidth);
	return text.slice(0, maxWidth - 1) + "…";
}

export function getDomain(url: string): string {
	try {
		const u = new URL(url);
		const host = u.hostname;
		// Drop leading "www." so www.example.com → example.com (matches omp's getDomain).
		return host.startsWith("www.") ? host.slice(4) : host;
	} catch {
		return "";
	}
}

export function formatCount(item: "source" | "line", n: number): string {
	const word = n === 1 ? item : `${item}s`;
	return `${n} ${word}`;
}

function visibleWidth(s: string): number {
	// Defer to Bun.stringWidth when available — it follows Unicode 15 grapheme
	// cluster rules and gives correct terminal width for emoji, CJK, and
	// combining marks. Otherwise fall back to a length count that strips
	// ANSI escapes.
	try {
		const w = Bun.stringWidth(s);
		if (typeof w === "number" && Number.isFinite(w)) return w;
	} catch {
		// Fall through to the manual estimate.
	}
	let w = 0;
	let inEscape = false;
	for (let i = 0; i < s.length; i++) {
		const ch = s[i]!;
		if (inEscape) {
			if (ch === "m") inEscape = false;
			continue;
		}
		if (ch === "\u001b") {
			inEscape = true;
			continue;
		}
		w += 1;
	}
	return w;
}

function padRight(s: string, width: number): string {
	const w = visibleWidth(s);
	if (w >= width) return s;
	return s + " ".repeat(width - w);
}

// ─── Header / status line ───────────────────────────────────────────────
const STATUS_ICONS = {
	pending: "◌",
	success: "●",
	warning: "⚠",
	error: "✗",
} as const;

type StatusKind = keyof typeof STATUS_ICONS;

function renderStatusLine(
	args: { icon: StatusKind; title: string; description?: string; meta?: string[] },
	theme: Theme,
): string {
	const parts: string[] = [];
	parts.push(theme.fg("dim", STATUS_ICONS[args.icon]));
	parts.push(theme.bold(theme.fg("toolTitle", args.title)));
	if (args.description) parts.push(theme.fg("accent", `"${args.description}"`));
	if (args.meta && args.meta.length > 0) {
		const sep = theme.fg("dim", " · ");
		parts.push(sep + args.meta.map((m) => theme.fg("muted", m)).join(sep));
	}
	return parts.join(" ");
}

// ─── Box frame ──────────────────────────────────────────────────────────
// Renders content into a rounded box with `╭─╮ │ ╰─╯` borders. Content lines
// are wrapped to `width` columns (visible width). Empty content lines stay
// blank for vertical breathing room.

const BOX_HORIZ = "─";
const BOX_VERT = "│";
const BOX_TL = "╭";
const BOX_TR = "╮";
const BOX_BL = "╰";
const BOX_BR = "╯";

export function stripHtml(s: string): string {
	if (typeof s !== "string") return "";
	// Remove HTML tags, then decode the common entities that survive.
	const noTags = s.replace(/<[^>]*>/g, "");
	return noTags
		.replace(/&nbsp;/g, " ")
		.replace(/&quot;/g, "\"")
		.replace(/&#39;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function wrapLine(text: string, width: number): string[] {
	if (width <= 0) return [""];
	if (text.length === 0) return [];
	// Word-aware wrap: tokens are whitespace-separated runs; emit a new line
	// whenever adding the next token would exceed `width`. Tokens longer than
	// `width` are emitted as-is on their own line (never split mid-word).
	const tokens = text.split(/(\s+)/);
	const lines: string[] = [];
	let cur = "";
	for (const tok of tokens) {
		if (tok.length === 0) continue;
		if (/^\s+$/.test(tok)) {
			// Preserve trailing whitespace at the end of a logical line — never
			// merge it into the next line. Skip if no current content yet.
			if (cur) cur += tok;
			continue;
		}
		const candidate = cur + tok;
		if (visibleWidth(candidate) <= width) {
			cur = candidate;
		} else {
			if (cur.trim().length > 0) lines.push(cur.trimEnd());
			cur = tok;
		}
	}
	if (cur.trim().length > 0) lines.push(cur.trimEnd());
	return lines;
}

// ─── Markdown stripping (graceful fallback for plain-text rendering) ────────
// Strips common Markdown syntax so snippets / answers rendered as plain text
// don't leak raw ##, **, [..](..) markers to the terminal. Lightweight regex-
// based — no parser dependency.
const HEADING_RE = /^\s{0,3}#{1,6}\s+(.*)$/;
const BOLD_RE = /\*\*(.+?)\*\*|__(.+?)__/g;
const ITALIC_RE = /(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)|_(.+?)_/g;
const CODE_RE = /`([^`]+)`/g;
const LINK_RE = /\[([^\]]+)\]\([^)]+\)/g;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const BULLET_RE = /^(\s*)[-*+]\s+(.*)$/;
const ORDERED_LIST_RE = /^(\s*)\d+\.\s+(.*)$/;

export function stripMarkdown(input: string): string {
	if (typeof input !== "string" || input.length === 0) return "";
	const out: string[] = [];
	for (const rawLine of input.split(/\r?\n/)) {
		const heading = rawLine.match(HEADING_RE);
		if (heading) {
			out.push(heading[1]!.trim());
			continue;
		}
		const quote = rawLine.match(QUOTE_RE);
		if (quote) {
			out.push(quote[1] ?? "");
			continue;
		}
		const bullet = rawLine.match(BULLET_RE);
		if (bullet) {
			const indent = bullet[1] ?? "";
			out.push(`${indent}• ${bullet[2] ?? ""}`);
			continue;
		}
		const ordered = rawLine.match(ORDERED_LIST_RE);
		if (ordered) {
			out.push(rawLine.replace(/^\s*/, ""));
			continue;
		}
		out.push(rawLine);
	}
	let result = out.join("\n");
	result = result.replace(LINK_RE, "$1");
	result = result.replace(BOLD_RE, (_m, a, b) => (a ?? b ?? ""));
	result = result.replace(ITALIC_RE, (_m, a, b) => (a ?? b ?? ""));
	result = result.replace(CODE_RE, (_m, c) => (c ?? ""));
	return result;
}

// ─── Multi-line wrap ────────────────────────────────────────────────────────
// Splits text on newlines and wraps each line independently so multi-paragraph
// content renders as separate paragraphs inside the box frame. Blank lines
// are preserved as empty content rows. Bullet lines get a 2-char hanging
// indent so wrapped continuations align under the bullet glyph.
export function wrapMultiLine(text: string, width: number): string[] {
	if (typeof text !== "string" || text.length === 0) return [];
	if (width <= 0) return text.split(/\r?\n/);
	const result: string[] = [];
	for (const rawLine of text.split(/\r?\n/)) {
		if (rawLine.trim().length === 0) {
			result.push("");
			continue;
		}
		const bulletMatch = rawLine.match(BULLET_RE);
		const orderedMatch = rawLine.match(ORDERED_LIST_RE);
		if (bulletMatch) {
			const indent = bulletMatch[1] ?? "";
			const body = bulletMatch[2] ?? "";
			const hanging = `${indent}• `;
			const contIndent = " ".repeat(hanging.length);
			const wrapped = wrapLine(body, width - hanging.length);
			for (let i = 0; i < wrapped.length; i++) {
				const line = wrapped[i]!;
				result.push(i === 0 ? `${hanging}${line}` : `${contIndent}${line}`);
			}
			continue;
		}
		if (orderedMatch) {
			const indent = orderedMatch[1] ?? "";
			const body = orderedMatch[2] ?? "";
			const prefixMatch = rawLine.match(/^\s*\d+\.\s+/)!;
			const hanging = `${indent}${prefixMatch[0].slice(indent.length)}`;
			const contIndent = " ".repeat(hanging.length);
			const wrapped = wrapLine(body, width - hanging.length);
			for (let i = 0; i < wrapped.length; i++) {
				const line = wrapped[i]!;
				result.push(i === 0 ? `${hanging}${line}` : `${contIndent}${line}`);
			}
			continue;
		}
		for (const w of wrapLine(rawLine, width)) result.push(w);
	}
	return result;
}

// ─── Age normalization ───────────────────────────────────────────────────────
// Brave returns age as a comma-joined string with multiple representations:
//   "Tuesday, August 04, 2026, 2026-08-04, 31 days ago, 2026-08-04T11:17:17Z"
// We pick the FIRST chunk that contains "ago" (relative form) or matches an
// ISO date (YYYY-MM-DD) when no relative form is present.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/;

export function normalizeAge(raw: string | string[] | null | undefined): string | undefined {
	if (raw === undefined || raw === null) return undefined;
	// Always split into comma-separated chunks. Brave's age is sometimes a
	// single-element array holding the full string, sometimes an already-split
	// multi-element array, sometimes a plain string — normalize all forms.
	const joined = Array.isArray(raw) ? raw.join(",") : raw;
	const parts = joined
		.split(",")
		.map((p) => p.trim())
		.filter((p) => p.length > 0);
	if (parts.length === 0) return undefined;
	const relative = parts.find((p) => /\bago\b/i.test(p));
	if (relative) return relative;
	const iso = parts.find((p) => ISO_DATE_RE.test(p));
	if (iso) return iso;
	for (const p of parts) {
		if (!ISO_DATETIME_RE.test(p)) return p;
	}
	return undefined;
}

function renderBoxFrame(
	content: string[],
	args: { header: string; width: number; padHeader?: boolean },
	theme: Theme,
): string {
	const innerWidth = Math.max(10, args.width - 2); // exclude side borders ╭╮
	const out: string[] = [];
	const headerText = args.padHeader === false ? args.header : " " + args.header;
	// Layout: ╭─ <header> ─...─╮
	// Between ╭ and ╮ the row spans (innerWidth) chars. ╭─ uses 2 of them (╭ plus the leading dash).
	// The trailing ╮ is 1 char outside that span — accounted for in totalWidth.
	const headerCap = Math.max(1, innerWidth - 1);
	const truncatedHeader = truncateToWidth(headerText, headerCap);
	const headerFill = Math.max(0, innerWidth - 1 - visibleWidth(truncatedHeader));
	out.push(
		theme.fg("dim", BOX_TL + BOX_HORIZ) +
			truncatedHeader +
			theme.fg("dim", BOX_HORIZ.repeat(headerFill) + BOX_TR),
	);
	for (const line of content) {
		for (const wrapped of wrapMultiLine(line, innerWidth)) {
			out.push(
				theme.fg("dim", BOX_VERT) +
					" " +
					padRight(wrapped, innerWidth - 1) +
					theme.fg("dim", BOX_VERT),
			);
		}
	}
	out.push(theme.fg("dim", BOX_BL + BOX_HORIZ.repeat(innerWidth) + BOX_BR));
	return out.join("\n");
}

// ─── Source tree list ───────────────────────────────────────────────────
const MAX_COLLAPSED_ITEMS = 8;

interface RenderSource {
  title: string;
  url: string;
  domain?: string;
  age?: string;
  snippet?: string;
  extraSnippets?: string[];
  favicon?: string;
}

function renderTreeList(
	items: RenderSource[],
	args: { expanded: boolean; maxCollapsed: number; itemType: "source"; width: number },
	theme: Theme,
): string[] {
	if (items.length === 0) {
		return [theme.fg("muted", `No ${args.itemType}s returned`)];
	}
	const visible = args.expanded ? items.length : Math.min(items.length, args.maxCollapsed);
	const remaining = items.length - visible;
	const lines: string[] = [];
	const showExtras = args.expanded || items.length <= 3;
	for (let i = 0; i < visible; i++) {
		const isLast = i === visible - 1 && remaining === 0;
		const branch = isLast ? "└─" : "├─";
		const src = items[i]!;
		const domain = src.domain ?? getDomain(src.url);
		// Meta is rendered on its OWN line below the title so a long title no
		// longer has to share column budget with the meta suffix.
		const metaParts: string[] = [];
		if (domain) metaParts.push(theme.fg("dim", `(${domain})`));
		if (src.age) metaParts.push(theme.fg("muted", src.age));
		const metaText = metaParts.join(" " + theme.fg("dim", "·") + " ");
		const titleInnerWidth = Math.max(10, args.width - 6);
		const titleText = src.title || src.url || "Untitled";
		const title = theme.fg("accent", truncateToWidth(titleText, titleInnerWidth));
		lines.push(`  ${theme.fg("dim", branch)} ${title}`);
		if (metaText.length > 0) {
			lines.push(`      ${metaText}`);
		}
		// Snippet (dim/muted, wrapped, indented to align under title).
		if (src.snippet) {
			for (const wrapped of wrapMultiLine(src.snippet, titleInnerWidth)) {
				lines.push(`      ${theme.fg("muted", wrapped)}`);
			}
		}
		// Extra snippets only when expanded OR small list.
		if (showExtras && src.extraSnippets) {
			for (const extra of src.extraSnippets) {
				for (const wrapped of wrapMultiLine(extra, titleInnerWidth)) {
					lines.push(`      ${theme.fg("dim", wrapped)}`);
				}
			}
		}
	}
	if (remaining > 0) {
		lines.push(
			"  " +
				theme.fg("dim", "└─") +
				" " +
				theme.fg("muted", `+${formatCount(args.itemType, remaining)} more`),
		);
	}
	return lines;
}
export function extractLlmSources(data: unknown): RenderSource[] {
	const d = data as LlmContextResponse | undefined;
	if (!d) return [];
	const cleanSnippet = (s: string | undefined): string | undefined => {
		if (s === undefined) return undefined;
		const cleaned = stripControls(stripHtml(s));
		return cleaned.length > 0 ? stripMarkdown(cleaned) : cleaned;
	};
	const sources: RenderSource[] = [];
	for (const g of d.grounding?.generic ?? []) {
		if (!g) continue;
		const firstSnippet = Array.isArray(g.snippets) && g.snippets.length > 0 ? g.snippets[0] : undefined;
		sources.push({
			title: stripControls(g.title ?? ""),
			url: g.url ?? "",
			age: normalizeAge(d.sources?.[g.url ?? ""]?.age),
			snippet: cleanSnippet(firstSnippet),
		});
	}
	for (const m of d.grounding?.map ?? []) {
		if (!m) continue;
		const firstSnippet = Array.isArray(m.snippets) && m.snippets.length > 0 ? m.snippets[0] : undefined;
		sources.push({
			title: stripControls(m.name ?? m.url ?? "Map result"),
			url: m.url ?? "",
			age: normalizeAge(d.sources?.[m.url ?? ""]?.age),
			snippet: cleanSnippet(firstSnippet),
		});
	}
	if (d.grounding?.poi) {
		const p = d.grounding.poi;
		const firstSnippet = Array.isArray(p.snippets) && p.snippets.length > 0 ? p.snippets[0] : undefined;
		sources.push({
			title: stripControls(p.name ?? "POI"),
			url: p.url ?? "",
			age: normalizeAge(d.sources?.[p.url ?? ""]?.age),
			snippet: cleanSnippet(firstSnippet),
		});
	}

	return sources;
}

export function extractWebSources(data: unknown): RenderSource[] {
	const d = data as WebSearchResponse | undefined;
	if (!d?.web?.results) return [];
	const cleanSnippet = (s: string | undefined): string | undefined => {
		if (s === undefined) return undefined;
		const cleaned = stripControls(stripHtml(s));
		return cleaned.length > 0 ? stripMarkdown(cleaned) : cleaned;
	};
	const cleanExtras = (xs: unknown): string[] | undefined => {
		if (!Array.isArray(xs)) return undefined;
		const out: string[] = [];
		for (const x of xs) {
			if (typeof x === "string") {
				const cleaned = stripControls(stripHtml(x));
				out.push(cleaned.length > 0 ? stripMarkdown(cleaned) : cleaned);
			}
		}
		return out.length > 0 ? out : undefined;
	};
	return d.web.results.map((r) => {
		const description = typeof r.description === "string" ? stripControls(stripHtml(r.description)) : undefined;
		const snippet = description && description.length > 0 ? stripMarkdown(description) : undefined;
		const extras = cleanExtras(r.extra_snippets);
		const favicon = typeof r.meta_url?.favicon === "string" ? stripControls(r.meta_url.favicon) : undefined;
		const hostname = typeof r.meta_url?.hostname === "string" ? r.meta_url.hostname : undefined;
		return {
			title: stripControls(r.title ?? ""),
			url: r.url ?? "",
			age: normalizeAge(r.age),
			snippet,
			extraSnippets: extras && extras.length > 0 ? extras : undefined,
			favicon: favicon && favicon.length > 0 ? favicon : undefined,
			domain: hostname && hostname.length > 0 ? hostname : undefined,
		};
	});
}

export interface RenderSearchOptions {
	expanded: boolean;
	width: number;
}

export function renderSearchResult(
	mode: "llm" | "web",
	response: unknown,
	opts: RenderSearchOptions,
	args: { query?: string },
	theme: Theme,
): string {
	const isLlm = mode === "llm";
	const sources = isLlm ? extractLlmSources(response) : extractWebSources(response);
	const success = sources.length > 0;
	const providerLabel = isLlm ? "Brave LLM Context" : "Brave Web Search";
	const header = renderStatusLine(
		{ icon: success ? "success" : "warning", title: "Web Search", description: providerLabel, meta: [formatCount("source", sources.length)] },
		theme,
	);
	const innerWidth = Math.max(20, opts.width - 2);
	const sections: string[] = [];

	if (args.query) {
		const q = truncateToWidth(stripControls(args.query), 80);
		sections.push(theme.fg("toolTitle", "Query"));
		sections.push(theme.fg("text", q));
	}

	if (isLlm) {
		const llmResp = response as LlmContextResponse | undefined;
		const answer = llmResp?.answer !== undefined ? stripControls(llmResp.answer).trim() : "";
		if (answer.length > 0) {
			sections.push(theme.fg("toolTitle", "Answer"));
			const cleaned = stripMarkdown(answer);
			for (const wrapped of wrapMultiLine(cleaned, innerWidth)) {
				sections.push(theme.fg("text", wrapped));
			}
		}
		const followUps = Array.isArray(llmResp?.follow_up_questions)
			? llmResp!.follow_up_questions.filter((q): q is string => typeof q === "string").map((q) => stripControls(q).trim()).filter((q) => q.length > 0)
			: [];
		if (followUps.length > 0) {
			sections.push(theme.fg("toolTitle", "Follow-ups"));
			for (const q of followUps) {
				for (const wrapped of wrapMultiLine(`• ${q}`, innerWidth)) {
					sections.push(theme.fg("dim", wrapped));
				}
			}
		}
	}

	sections.push(theme.fg("toolTitle", "Sources"));
	for (const line of renderTreeList(
		sources,
		{ expanded: opts.expanded, maxCollapsed: MAX_COLLAPSED_ITEMS, itemType: "source", width: opts.width },
		theme,
	)) {
		sections.push(line);
	}

	// Web total results overflow indicator.
	if (!isLlm) {
		const webResp = response as WebSearchResponse | undefined;
		const total = typeof webResp?.web?.total?.results === "number" ? webResp.web.total.results : undefined;
		if (typeof total === "number" && total > sources.length) {
			sections.push(theme.fg("muted", `…and ${total - sources.length} more results`));
		}
	}

	// Metadata block: provider label + source URL list (counts as provenance).
	sections.push(theme.fg("toolTitle", "Metadata"));
	sections.push(
		`${theme.fg("muted", "Provider:")} ${theme.fg("text", providerLabel + (isLlm ? "" : " (Web)"))}`,
	);
	if (sources.length > 0 && sources.length <= MAX_COLLAPSED_ITEMS) {
		const urls = sources.map((s) => s.url).filter((u) => u);
		if (urls.length > 0) {
			sections.push(`${theme.fg("muted", "URLs:")} ${theme.fg("dim", urls.join(", "))}`);
		}
	}

	return renderBoxFrame(
		sections,
		{ header, width: opts.width },
		theme,
	);
}

// Legacy export kept for backward-compat with existing tests / imports.
// (The old ASCII pipe-table renderer is gone; this returns plain text from
// the raw API response using the same field order as before.)
export function renderApiResponseAsTable(data: unknown, mode: "llm" | "web"): string {
	const sources = mode === "llm" ? extractLlmSources(data) : extractWebSources(data);
	if (sources.length === 0) return "No results";
	return sources
		.map((s, i) => `${i + 1}. ${s.title || s.url}` + (s.url ? ` — ${s.url}` : ""))
		.join("\n");
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
      return okResult(text, { urls, exitCode: 0, mode: "llm", response: data });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("OPTION_NOT_IN_PLAN")) {
        const data = await performWebSearch(params, apiKey);
        const text = renderApiResponseAsTable(data, "web");
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

export function renderCall(
  args: BsearchParams,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const q = truncateToWidth(stripControls(args.query ?? ""), 80);
  const meta: string[] = [];
  if (args.count !== undefined) meta.push(formatCount("source", args.count));
  if (args.freshness) meta.push(`fresh=${args.freshness}`);
  if (args.country) meta.push(`country=${args.country.toUpperCase()}`);
  if (args.local) meta.push("local");
  const header = renderStatusLine(
    {
      icon: "pending",
      title: "Web Search",
      description: q ? `"${q}"` : "",
      meta: meta.length > 0 ? meta : undefined,
    },
    theme,
  );
  return new Text(header, 0, 0);
}

export function renderResult(
  result: AgentToolResult<BsearchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args?: BsearchParams,
): Component {
  // Error path — error panel, no source extraction.
  if (result.isError) {
    const msg = result.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    const header = renderStatusLine(
      { icon: "error", title: "Web Search", description: "Brave Search" },
      theme,
    );
    const body = renderBoxFrame(
      [theme.fg("error", `Error: ${stripControls(msg)}`)],
      { header, width: 80, padHeader: false },
      theme,
    );
    return new Text(body, 0, 0);
  }

  // Success path — extract from raw response (not the rendered text).
  const mode = result.details?.mode ?? "llm";
  const response = result.details?.response;

  const rendered = renderSearchResult(
    mode,
    response,
    { expanded: options.expanded, width: DEFAULT_RENDER_WIDTH },
    { query: args?.query },
    theme,
  );
  return new Text(rendered, 0, 0);
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
