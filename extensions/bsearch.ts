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
import type { TextContent } from "@oh-my-pi/pi-ai";

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

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

function okResult(text: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  return { content: [textContent(text)], details, isError: false };
}

function errResult(message: string, details: BsearchDetails): AgentToolResult<BsearchDetails> {
  return { content: [textContent(message)], details, isError: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension entry point
// ─────────────────────────────────────────────────────────────────────────────

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
    name: "brave_search",
    label: "Brave Web Search",
    description: "Search the web using Brave Search API. Returns LLM-contextualized results (snippets + URLs) for research, fact-checking, and answering questions about current events. Use this when you need current information from the web.",
    parameters: BsearchParamsSchema,
    hidden: false,
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
