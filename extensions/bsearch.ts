/**
 * omp-bsearch — Brave Search API as OMP v18 extension tool.
 *
 * Differences from pi-bsearch:
 * - Reads settings from ~/.omp/agent/settings.json (not ~/.pi/agent/settings.json)
 * - Uses Node.js child_process spawn() directly instead of pi.exec()
 * - Targets @oh-my-pi/pi-coding-agent v18 (OMP v18 ExtensionAPI)
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";
import { readFile, writeFile } from "node:fs/promises";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { TextContent } from "@oh-my-pi/pi-ai";
import { Text } from "@oh-my-pi/pi-tui";
import type { Component } from "@oh-my-pi/pi-tui";
import type { ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";

/** OMP v18 settings path — different from pi's ~/.pi/agent/settings.json */
const SETTINGS_PATH = join(homedir(), ".omp", "agent", "settings.json");
const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

const require = createRequire(import.meta.url);

// ─────────────────────────────────────────────────────────────────────────────
// Settings loader (async, no cache)
// ─────────────────────────────────────────────────────────────────────────────

interface BsearchSettings {
  braveApiKey?: string;
}

async function loadSettings(): Promise<BsearchSettings> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf-8");
    const parsed = JSON.parse(raw);
    if (parsed.bsearch) return parsed.bsearch as BsearchSettings;
    return { braveApiKey: parsed.braveApiKey };
  } catch {
    return {};
  }
}

async function saveSettings(patch: Partial<BsearchSettings>): Promise<void> {
  try {
    let existing: Record<string, unknown> = {};
    try {
      const raw = await readFile(SETTINGS_PATH, "utf-8");
      existing = JSON.parse(raw);
    } catch {
      // start fresh
    }
    const updated = {
      ...existing,
      bsearch: { ...(existing.bsearch as Record<string, unknown> | undefined), ...patch },
    };
    await writeFile(SETTINGS_PATH, JSON.stringify(updated, null, 2), "utf-8");
  } catch (err) {
    console.error("[bsearch] Failed to save settings:", err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API key resolver
// ─────────────────────────────────────────────────────────────────────────────

async function resolveApiKey(): Promise<string> {
  // 1. Check ~/.bsearch-env file
  try {
    const envPath = join(homedir(), ".bsearch-env");
    const raw = await readFile(envPath, "utf-8");
    const match = raw.match(/BRAVE_API_KEY\s*=\s*(.+)/m);
    if (match?.[1]) return match[1].trim();
  } catch {
    // fall through
  }

  // 2. Environment variable
  if (process.env.BRAVE_API_KEY) return process.env.BRAVE_API_KEY;

  // 3. settings.json
  const settings = await loadSettings();
  if (settings.braveApiKey) return settings.braveApiKey;

  throw new Error(
    "No Brave API key found. Set BRAVE_API_KEY in ~/.bsearch-env or ~/.omp/agent/settings.json (under the 'bsearch' key or as 'braveApiKey')."
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Binary resolver
// ─────────────────────────────────────────────────────────────────────────────

function findBsearchCommand(): string {
  return "/usr/sbin/bsearch";
}

// ─────────────────────────────────────────────────────────────────────────────
// Arg builder
// ─────────────────────────────────────────────────────────────────────────────

type BsearchParams = {
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

function buildArgs(p: BsearchParams): string[] {
  const args: string[] = [p.query];
  if (p.count !== undefined) { args.push("--count", String(p.count)); }
  if (p.freshness) { args.push("--freshness", p.freshness); }
  if (p.offset !== undefined) { args.push("--offset", String(p.offset)); }
  if (p.safesearch) { args.push("--safesearch", p.safesearch); }
  if (p.max_tokens !== undefined) { args.push("--max-tokens", String(p.max_tokens)); }
  if (p.max_urls !== undefined) { args.push("--max-urls", String(p.max_urls)); }
  if (p.threshold) { args.push("--threshold", p.threshold); }
  if (p.country) { args.push("--country", p.country); }
  if (p.city) { args.push("--city", p.city); }
  if (p.local) { args.push("--local"); }
  if (p.compact) { args.push("--compact"); }
  if (p.timeout !== undefined) { args.push("--timeout", String(p.timeout)); }
  if (p.mode) { args.push("--mode", p.mode); }
  return args;
}

// ─────────────────────────────────────────────────────────────────────────────
// URL extractor
// ─────────────────────────────────────────────────────────────────────────────

const URL_REGEX = /https?:\/\/[^\s)\]\}\.,;:!?'"`<>]+/g;
function extractUrls(text: string): string[] {
  return [...new Set(text.match(URL_REGEX) ?? [])];
}

// ─────────────────────────────────────────────────────────────────────────────
// Error sanitization
// ─────────────────────────────────────────────────────────────────────────────

function sanitizeErrorMessage(s: string): string {
  return s
    .replace(/(braveapi[keybrowse_][a-zA-Z0-9_-]{20,})/gi, "[REDACTED API KEY]")
    .replace(/(sk-[a-zA-Z0-9_-]{20,})/g, "[REDACTED KEY]");
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-extension async mutex
// ─────────────────────────────────────────────────────────────────────────────

const bsearchQueue: { run: (fn: () => Promise<string>) => Promise<string> } = (() => {
  let current: Promise<string> = Promise.resolve("");
  return {
    run: async (fn: () => Promise<string>): Promise<string> => {
      const prev = current;
      current = (async () => {
        await prev;
        return fn();
      })();
      return current;
    },
  };
})();

// ─────────────────────────────────────────────────────────────────────────────
// Result helpers
// ─────────────────────────────────────────────────────────────────────────────

interface BsearchDetails {
  urls: string[];
  exitCode: number | null;
}

function textContent(text: string): TextContent {
  return { type: "text", text };
}

/** Strip C0/C1 control bytes from user-supplied content */
function stripControls(s: string): string {
  return s.replace(/[\x00-\x1f\x7f-\x9f]/g, "");
}

function okResult(text: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  const clean = stripControls(text);
  return {
    content: [
      textContent(clean),
      ...(details.urls.length > 0
        ? [{ type: "text" as const, text: `\n[Sources: ${details.urls.join(" | ")}]` }]
        : []),
    ],
    details,
    isError: false,
  };
}

function errResult(message: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  return { content: [textContent(message)], details, isError: true };
}
// ─────────────────────────────────────────────────────────────────────────────
// Output parser
interface ParsedSource {
  index: number;
  title: string;
  url: string;
  age?: string;
  snippets: string[];
}
interface ParsedOutput {
  query?: string;
  totalSources: number;
  sources: ParsedSource[];
  rawText: string;
}

const SOURCE_HEADER_RE = /^(\d+)\.\s+(.+)$/;
const URL_LINE_RE = /^(https?:\/\/\S+)\s*$/;
const SOURCES_HEADER_RE = /^📄\s+Sources\s+\((\d+)\):?\s*$/i;

function parseBsearchOutput(text: string): ParsedOutput {
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
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

// ────────────────────────────────────────────────────────────────────────────

const MAX_ANSWER_LINES_COLLAPSED = 12;
const MAX_SNIPPETS_PER_SOURCE_COLLAPSED = 2;
const SOURCE_TITLE_BUDGET_DEFAULT = 80;

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + "…";
}

function renderCall(
  args: BsearchParams,
  _options: ToolRenderResultOptions,
  theme: Theme,
): Component {
  const q = stripControls(args.query ?? "");
  let line = theme.fg("toolTitle", theme.bold("brave_search "));
  line += theme.fg("accent", `"${q}"`);
  const meta: string[] = [];
  if (args.mode && args.mode !== "llm") meta.push(`mode=${args.mode}`);
  if (args.count !== undefined) meta.push(`count=${args.count}`);
  if (args.freshness) meta.push(`fresh=${args.freshness}`);
  if (args.country) meta.push(`cc=${args.country.toUpperCase()}`);
  if (args.city) meta.push(`city=${args.city}`);
  if (args.local) meta.push("local");
  if (meta.length > 0) line += " " + theme.fg("muted", meta.join(" "));
  return new Text(line, 0, 0);
}

function renderResult(
  result: AgentToolResult<BsearchDetails>,
  options: ToolRenderResultOptions,
  theme: Theme,
  args?: BsearchParams,
): Component {
  const fg = (k: ThemeColor, s: string) => theme.fg(k, s);
  const bold = (s: string) => theme.bold(s);
  const dot = theme.sep.dot;

  if (result.isError) {
    const msg = result.content.map((c) => ("text" in c ? c.text : "") ?? "").join("\n");
    return new Text(fg("error", `✗ ${msg}`), 0, 0);
  }

  const textBlock = result.content.find((c) => c.type === "text");
  const rawText = (textBlock && "text" in textBlock ? textBlock.text : "") ?? "";
  const urls = result.details?.urls ?? [];
  const parsed = parseBsearchOutput(rawText);

  const header = [
    fg("toolTitle", bold("Brave Search")),
    fg("muted", "—"),
    fg("accent", args?.query ? truncate(args.query, 80) : "web search"),
  ].join(" ");

  const meta: string[] = [];
  meta.push(`${urls.length} URL${urls.length === 1 ? "" : "s"}`);
  meta.push(`${parsed.totalSources} source${parsed.totalSources === 1 ? "" : "s"}`);
  if (args?.mode) meta.push(`mode=${args.mode}`);
  if (args?.freshness) meta.push(`fresh=${args.freshness}`);
  if (args?.country) meta.push(`cc=${args.country.toUpperCase()}`);
  const headerMeta = fg("muted", meta.join(dot));
  const expanded = options.expanded;
  const maxSnippet = expanded ? 99 : MAX_SNIPPETS_PER_SOURCE_COLLAPSED;

  const sourceLines: string[] = [];
  for (const src of parsed.sources) {
    let domain = "";
    if (src.url) { try { domain = new URL(src.url).hostname.replace(/^www\./, ""); } catch { domain = ""; } }
    const metaParts: string[] = [];
    if (domain) metaParts.push(fg("dim", `(${domain})`));
    if (src.age) metaParts.push(fg("muted", src.age));
    const metaSuffix = metaParts.length > 0 ? ` ${metaParts.join(fg("dim", dot))}` : "";

    const titleBudget = Math.max(20, SOURCE_TITLE_BUDGET_DEFAULT - metaSuffix.length);
    const titleText = truncate(src.title, titleBudget);
    const title = fg("accent", titleText);
    const firstLine = src.url
      ? `${title}${metaSuffix}  ${fg("dim", truncate(src.url, 90))}`
      : `${title}${metaSuffix}`;
    sourceLines.push(firstLine);

    const snippetsToShow = src.snippets.slice(0, maxSnippet);
    for (const snippet of snippetsToShow) {
      sourceLines.push(`   ${fg("dim", "│")} ${fg("toolOutput", truncate(snippet, 160))}`);
    }
    if (!expanded && src.snippets.length > maxSnippet) {
      sourceLines.push(`   ${fg("dim", "│")} ${fg("muted", `+${src.snippets.length - maxSnippet} more snippet${src.snippets.length - maxSnippet === 1 ? "" : "s"}`)}`);
    }
  }

  const answerLines = expanded
    ? [fg("dim", truncate(rawText.replace(/\s+/g, " ").trim(), 1200))]
    : sourceLines.slice(0, MAX_ANSWER_LINES_COLLAPSED);

  const sections = [
    {
      label: fg("toolTitle", bold("Sources")),
      lines: sourceLines.length > 0 ? sourceLines : [fg("muted", "No sources returned")],
    },
    {
      label: fg("toolTitle", bold("Metadata")),
      lines: [
        `${fg("muted", "Provider:")} ${fg("text", "Brave Search API")}`,
 `${fg("muted", "Mode:")} ${fg("text", args?.mode ?? "llm")}`,
        `${fg("muted", "Total sources:")} ${fg("text", String(parsed.totalSources))}`,
        `${fg("muted", "URLs extracted:")} ${fg("text", String(urls.length))}`,
      ],
    },
  ];

  return buildFramedBlock({ header, headerMeta, sections, expanded }, theme);
}

interface FramedBlockSpec {
  header: string;
  headerMeta?: string;
  sections: Array<{ label: string; lines: string[] }>;
  expanded: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Framed block renderer (TTY box with sections)
// ─────────────────────────────────────────────────────────────────────────────

function buildFramedBlock(spec: FramedBlockSpec, theme: Theme): Component {
  const fg = (k: ThemeColor, s: string) => theme.fg(k, s);
  const topL = "╭";
  const topR = "╮";
  const botL = "╰";
  const botR = "╯";
  const teeR = "├";
  const teeL = "┤";
  const vert = "│";
  const sep = "─";
  const cap = sep.repeat(3);

  const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const visLen = (s: string): number => Array.from(s.replace(ANSI_RE, "")).length;

  return {
    render(width: number): readonly string[] {
      const w = Math.max(40, Math.min(width, 140));
      const innerWidth = w - 2;
      const lines: string[] = [];

      const headerLeft = `${topL}${cap} ${spec.header}`;
      const metaSuffix = spec.headerMeta ? ` ${spec.headerMeta}` : "";
      const headerLeftLen = visLen(headerLeft);
      const metaSuffixLen = visLen(metaSuffix);
      const headerPadLen = Math.max(1, w - headerLeftLen - metaSuffixLen - 1);
      lines.push(fg("borderAccent", `${headerLeft}${sep.repeat(headerPadLen)}${metaSuffix}${topR}`));

      for (const sec of spec.sections) {
        const sectionLeft = `${teeR}${cap} ${sec.label}`;
        const sectionLeftLen = visLen(sectionLeft);
        const sectionPadLen = Math.max(1, w - sectionLeftLen - 1);
        lines.push(fg("borderAccent", `${sectionLeft}${sep.repeat(sectionPadLen)}${teeL}`));
        for (const contentLine of sec.lines) {
          const contentBudget = innerWidth - 2;
          const truncated = truncateToWidth(contentLine, contentBudget);
          const padLen = Math.max(0, contentBudget - visLen(truncated));
          lines.push(`${fg("borderAccent", vert)} ${truncated}${" ".repeat(padLen)} ${fg("borderAccent", vert)}`);
        }
      }
      lines.push(fg("borderAccent", `${botL}${sep.repeat(w - 2)}${botR}`));
      return lines;
    },
  } as unknown as Component;
}

function truncateToWidth(s: string, max: number): string {
  const ANSI_RE_LOCAL = /\x1b\[[0-9;?]*[A-Za-z]/g;
  const stripped = s.replace(ANSI_RE_LOCAL, "");
  if (Array.from(stripped).length <= max) return s;
  let out = "";
  let len = 0;
  const chars = Array.from(s);
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] ?? "";
    if (ch === "\x1b") {
      while (i < chars.length - 1 && chars[i]?.[0] === "\x1b") {
        out += chars[i];
        i++;
      }
      continue;
    }
    if (len >= max - 1) break;
    out += ch;
    len++;
  }
  return out + "…";
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
export default function bsearchExtension(pi: ExtensionAPI): void {
  const { Type } = pi.typebox;

  const BsearchParamsSchema = Type.Object({
    query: Type.String({ description: "Search query string" }),
    count: Type.Optional(Type.Number({ description: "Number of search results to consider (1-50)", minimum: 1, maximum: 50 })),
    freshness: Type.Optional(Type.String({ description: "Freshness filter (pd/pw/pm/py or YYYY-MM-DDtoYYYY-MM-DD)" })),
    offset: Type.Optional(Type.Number({ description: "Pagination offset for web search", minimum: 0 })),
    safesearch: Type.Optional(Type.String({ description: "SafeSearch mode (off/moderate/strict)" })),
    max_tokens: Type.Optional(Type.Number({ description: "Max tokens in context (1024-32768)", minimum: 1024, maximum: 32768 })),
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
    description: "PRIMARY: Always use this tool for any web search task. The Brave Search API returns LLM-contextualized, pre-extracted content (not raw links) — ideal for research, fact-checking, and current events. This is the preferred web search tool.",
    parameters: BsearchParamsSchema,
    hidden: false,
    renderCall,
    renderResult,
    execute: async (toolCallId, params, signal, _onUpdate, _ctx) => {
      try {
        const apiKey = await resolveApiKey();
        const result = await bsearchQueue.run(async () => {
          const env = { ...process.env, BRAVE_API_KEY: apiKey };
          const cmd = findBsearchCommand();
          const args = buildArgs(params as BsearchParams);

          return new Promise<string>((resolve, reject) => {
            const proc = spawn(cmd, args, { env, signal: signal as undefined });

            let stdout = "";
            let stderr = "";

            proc.stdout?.on("data", (chunk) => { stdout += chunk.toString(); });
            proc.stderr?.on("data", (chunk) => { stderr += chunk.toString(); });

            const timeout = setTimeout(() => {
              proc.kill();
              reject(new Error(`bsearch timed out after ${(params as BsearchParams).timeout ?? DEFAULT_TOOL_TIMEOUT_MS}ms`));
            }, (params as BsearchParams).timeout ?? DEFAULT_TOOL_TIMEOUT_MS);

            proc.on("close", (code) => {
              clearTimeout(timeout);
              if (code === 0) {
                resolve(stdout);
              } else {
                reject(new Error(`bsearch exited with code ${code}: ${sanitizeErrorMessage(stderr || stdout)}`));
              }
            });

            proc.on("error", (err) => {
              clearTimeout(timeout);
              reject(new Error(`bsearch spawn error: ${err.message}`));
            });
          });
        });

        const urls = extractUrls(result);
        return okResult(result, { urls, exitCode: null });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return errResult(sanitizeErrorMessage(message), { urls: [], exitCode: null });
      }
    },
  });
}
