import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import bsearchExtension, {
  type BsearchDetails,
  type BsearchParams,
  parseBsearchOutput,
  renderCall,
  renderResult,
} from "./bsearch.js";

// ─── Stub theme ─────────────────────────────────────────────────────────────
// renderCall/renderResult call theme.fg/bold/sep. For tests we need a no-op
// theme that preserves text so we can assert against the rendered output.

const stubTheme: Theme = {
  fg: (_k: ThemeColor, s: string) => s,
  bold: (s: string) => s,
  sep: { dot: "·", pipe: "│" },
} as unknown as Theme;

// ─── Helpers ────────────────────────────────────────────────────────────────

function flatten(c: Component | undefined): string {
  if (!c) return "";
  const t = c as unknown as { getText?: () => string; render?: (w: number) => readonly string[] };
  if (typeof t.getText === "function") return t.getText();
  if (typeof t.render === "function") return [...t.render(400)].join("\n");
  return "";
}

function makeResult(text: string, opts?: { error?: boolean }): AgentToolResult<BsearchDetails> {
  return {
    content: [{ type: "text", text }],
    details: { urls: ["https://example.com"], exitCode: 0, mode: "llm" as const },
    isError: opts?.error ?? false,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const SAMPLE_OUTPUT = `📄 Sources (3):

1. First Source Title
   https://first.example.com
   First source snippet line one.
   First source snippet line two.

2. Second Source Title
   https://second.example.com
   (1 day ago)
   Second source snippet.

3. Third Source Title
   https://third.example.com
   Third snippet A.
   Third snippet B.
   Third snippet C.
`;

const EMPTY_OUTPUT = `📄 Sources (0):

`;

const ERROR_OUTPUT = "bsearch exited with code 1: network error";

// ─── parseBsearchOutput ─────────────────────────────────────────────────────

describe("parseBsearchOutput", () => {
  test("parses header with explicit totalSources", () => {
    const result = parseBsearchOutput(SAMPLE_OUTPUT);
    expect(result.totalSources).toBe(3);
    expect(result.sources).toHaveLength(3);
  });

  test("captures index, title, url per source", () => {
    const result = parseBsearchOutput(SAMPLE_OUTPUT);
    expect(result.sources[0]).toMatchObject({
      index: 1,
      title: "First Source Title",
      url: "https://first.example.com",
    });
    expect(result.sources[1]?.url).toBe("https://second.example.com");
    expect(result.sources[2]?.url).toBe("https://third.example.com");
  });

  test("captures all snippet lines per source", () => {
    const result = parseBsearchOutput(SAMPLE_OUTPUT);
    expect(result.sources[0]?.snippets).toEqual([
      "First source snippet line one.",
      "First source snippet line two.",
    ]);
    expect(result.sources[2]?.snippets).toHaveLength(3);
  });

  test("captures age tag in parentheses", () => {
    const result = parseBsearchOutput(SAMPLE_OUTPUT);
    expect(result.sources[1]?.age).toBe("1 day ago");
  });

  test("returns empty sources for empty output without crashing", () => {
    const result = parseBsearchOutput(EMPTY_OUTPUT);
    expect(result.sources).toEqual([]);
    expect(result.totalSources).toBe(0);
  });

  test("preserves rawText for raw rendering", () => {
    const result = parseBsearchOutput(SAMPLE_OUTPUT);
    expect(result.rawText).toBe(SAMPLE_OUTPUT);
  });

  test("falls back to sources.length if totalSources missing", () => {
    const noHeader = `1. Only Source
   https://only.example.com
   Some snippet.
`;
    const result = parseBsearchOutput(noHeader);
    expect(result.totalSources).toBe(1);
    expect(result.sources).toHaveLength(1);
  });
});

// ─── renderCall ─────────────────────────────────────────────────────────────

describe("renderCall", () => {
  const opts: ToolRenderResultOptions = { expanded: false, isPartial: false };

  test("includes query in quotes", () => {
    const args: BsearchParams = { query: "typescript testing" };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).toContain('"typescript testing"');
  });

  test("does NOT contain hardcoded 'brave_search ' prefix (Fix #1)", () => {
    const args: BsearchParams = { query: "x" };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).not.toMatch(/brave_search\s+/);
    expect(out).toMatch(/Brave Search/);
  });

  test("shows count when provided", () => {
    const args: BsearchParams = { query: "x", count: 5 };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).toContain("count=5");
  });

  test("hides mode=llm (default)", () => {
    const args: BsearchParams = { query: "x", mode: "llm" };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).not.toContain("mode=");
  });

  test("shows mode=web when explicit", () => {
    const args: BsearchParams = { query: "x", mode: "web" };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).toContain("mode=web");
  });

  test("strips ESC and NUL control bytes from query", () => {
    const args: BsearchParams = { query: "safe\x00\x1bDANGEROUS" };
    const out = flatten(renderCall(args, opts, stubTheme));
    expect(out).toContain("safeDANGEROUS");
    expect(out).not.toContain("\x00");
    expect(out).not.toContain("\x1b");
  });
});

// ─── renderResult ───────────────────────────────────────────────────────────

describe("renderResult", () => {
  const opts: ToolRenderResultOptions = { expanded: false, isPartial: false };
  const expandedOpts: ToolRenderResultOptions = { expanded: true, isPartial: false };

  test("renders plain-text header with mode + counts", () => {
    const result = makeResult(SAMPLE_OUTPUT);
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("Brave Search (llm)");
    expect(out).toMatch(/\d+ URLs?\s+·\s+3 sources/);
  });

  test("renders source content line by line (plain text append)", () => {
    const result = makeResult(SAMPLE_OUTPUT);
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("First Source Title");
    expect(out).toContain("https://first.example.com");
    expect(out).toContain("First source snippet line one.");
  });

  test("error result renders error marker", () => {
    const result = makeResult(ERROR_OUTPUT, { error: true });
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("✗");
  });

  test("expanded mode preserves all source content", () => {
    const result = makeResult(SAMPLE_OUTPUT);
    const out = flatten(renderResult(result, expandedOpts, stubTheme));
    expect(out).toContain("First Source Title");
    expect(out).toContain("Third snippet C.");
  });

  test("collapsed mode truncates very long output", () => {
    const longText = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n");
    const result = makeResult(longText);
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("line 1");
    expect(out).toContain("[+120 more lines]");
  });
});

// ─── Tool registration guard (regression) ──────────────────────────────────

describe("dual tool registration", () => {
  test("module exports a default factory function", () => {
    expect(typeof bsearchExtension).toBe("function");
  });
});
