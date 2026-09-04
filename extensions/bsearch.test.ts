import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import bsearchExtension, {
  type BsearchDetails,
  type BsearchParams,
  coerceParams,
  renderApiResponseAsTable,
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



// ─── renderApiResponseAsTable (ASCII table) ────────────────────────────────

const SAMPLE_LLM_CONTEXT = {
  grounding: {
    generic: [
      { title: "X — long title for testing", url: "https://x.example/path", snippets: ["first snippet text", "second snippet text"] },
      { title: "Y", url: "https://y.example", snippets: ["third snippet"] },
    ],
    poi: { name: "Brandenburger Tor", url: "https://poi.example", snippets: ["historic landmark in Berlin"] },
  },
  sources: {
    "https://x.example/path": { hostname: "x.example", age: ["2 days ago"] },
    "https://y.example": { hostname: "y.example" },
  },
};

const SAMPLE_WEB_SEARCH = {
  web: {
    results: [
      { title: "R1", url: "https://r1.example", description: "first description", age: "2 days ago" },
      { title: "R2", url: "https://r2.example", description: "second description" },
      { title: "R3", url: "https://r3.example", description: "third description", age: "1 week ago" },
    ],
    total: { results: 42 },
  },
};

describe("renderApiResponseAsTable", () => {
  test("LLM mode: renders grounding.generic as ASCII table with #/Title/URL/Snippets columns", () => {
    const text = renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm");
    expect(text).toMatch(/\|\s*#\s*\|\s*Title\s*\|\s*URL\s*\|\s*Snippets\s*\|/);
    expect(text).toContain("https://x.example/path");
    expect(text).toContain("https://y.example");
    expect(text).toContain("first snippet text | second snippet text");
    expect(text).toContain("third snippet");
    // Two data rows from the fixture (1 and 2 in the first data table).
    expect(text).toMatch(/^\|\s*1\s*\|/m);
    expect(text).toMatch(/^\|\s*2\s*\|/m);
  });

  test("LLM mode: renders grounding.poi as a 1-row mini table", () => {
    const text = renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm");
    expect(text).toContain("Brandenburger Tor");
    expect(text).toContain("historic landmark in Berlin");
    // poi table has exactly one data row numbered "1" after a Name header.
    const poiBlock = text.split("Name")[1] ?? "";
    expect(poiBlock).toMatch(/^\|\s*1\s*\|/m);
  });

  test("LLM mode: renders sources block as #/Hostname/URL/Age table", () => {
    const text = renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm");
    expect(text).toMatch(/\|\s*#\s*\|\s*Hostname\s*\|\s*URL\s*\|\s*Age\s*\|/);
    expect(text).toContain("x.example");
    expect(text).toContain("y.example");
  });

  test("LLM mode: empty grounding → 'No results'", () => {
    expect(renderApiResponseAsTable({}, "llm")).toBe("No results");
    expect(renderApiResponseAsTable({ grounding: {} }, "llm")).toBe("No results");
  });

  test("Web mode: renders results as #/Title/URL/Description/Age table", () => {
    const text = renderApiResponseAsTable(SAMPLE_WEB_SEARCH, "web");
    expect(text).toMatch(/\|\s*#\s*\|\s*Title\s*\|\s*URL\s*\|\s*Description\s*\|\s*Age\s*\|/);
    expect(text).toContain("https://r1.example");
    expect(text).toContain("first description");
    expect(text).toContain("2 days ago");
    expect(text).toContain("https://r3.example");
    // Three data rows: numbered 1, 2, 3.
    expect(text).toMatch(/^\|\s*1\s*\|/m);
    expect(text).toMatch(/^\|\s*2\s*\|/m);
    expect(text).toMatch(/^\|\s*3\s*\|/m);
  });

  test("Web mode: shows total hint from web.total.results", () => {
    const text = renderApiResponseAsTable(SAMPLE_WEB_SEARCH, "web");
    expect(text).toContain("Total results reported by Brave: 42");
  });

  test("Web mode: empty results → 'No results'", () => {
    expect(renderApiResponseAsTable({}, "web")).toBe("No results");
    expect(renderApiResponseAsTable({ web: { results: [] } }, "web")).toBe("No results");
  });

  test("clamps overlong fields to 80 chars (with ellipsis)", () => {
    const long = "x".repeat(200);
    const data = {
      web: { results: [{ title: long, url: "https://long", description: "d" }] },
    };
    const text = renderApiResponseAsTable(data, "web");
    const lines = text.split("\n");
    const sepIdx = lines.findIndex((l) => l.startsWith("|---"));
    const dataLine = lines[sepIdx + 1] ?? "";
    // Title column is bounded; whole data line stays under a reasonable cap.
    expect(dataLine.length).toBeLessThan(400);
    expect(dataLine).toContain("…");
  });
});

const ERROR_OUTPUT = "bsearch exited with code 1: network error";
describe("renderResult", () => {
  const opts: ToolRenderResultOptions = { expanded: false, isPartial: false };
  const expandedOpts: ToolRenderResultOptions = { expanded: true, isPartial: false };

  test("renders header with mode + URL count (no 'sources' word in header line)", () => {
    const result = makeResult(renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm"));
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    const headerLine = out.split("\n")[0] ?? "";
    expect(headerLine).toContain("Brave Search (llm)");
    expect(headerLine).toContain('"test"');
    expect(headerLine).toMatch(/\d+ URLs?$/);
    expect(headerLine).not.toContain("sources");
  });

  test("includes the query in quotes in the rendered header", () => {
    const result = makeResult(renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm"));
    const out = flatten(renderResult(result, opts, stubTheme, { query: "rust async" }));
    expect(out).toContain('"rust async"');
  });

  test("renders table body line by line (no raw JSON, contains URL column)", () => {
    const result = makeResult(renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm"));
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("https://x.example/path");
    expect(out).toContain("https://y.example");
    expect(out).not.toContain('"generic"');
    expect(out).not.toContain('"snippets": [');
  });

  test("error result renders error marker", () => {
    const result = makeResult(ERROR_OUTPUT, { error: true });
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("✗");
  });

  test("expanded mode preserves all table content", () => {
    const result = makeResult(renderApiResponseAsTable(SAMPLE_LLM_CONTEXT, "llm"));
    const out = flatten(renderResult(result, expandedOpts, stubTheme));
    expect(out).toContain("https://x.example/path");
    expect(out).toContain("https://y.example");
  });
  test("collapsed mode truncates very long table output", () => {
    // Build a fixture large enough to exceed COLLAPSED_MAX_LINES (80) of lines.
    const big = {
      web: {
        results: Array.from({ length: 200 }, (_, i) => ({
          title: `R${i}`,
          url: `https://r${i}.example`,
          description: "x".repeat(200),
          age: "1 day ago",
        })),
      },
    };
    const longText = renderApiResponseAsTable(big, "web");
    const result = makeResult(longText);
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("R0");
    expect(out).toMatch(/\[\+\d+ more lines\]/);
  });
});

// ─── Tool registration guard (regression) ──────────────────────────────────

describe("dual tool registration", () => {
  test("module exports a default factory function", () => {
    expect(typeof bsearchExtension).toBe("function");
  });
});

// ─── coerceParams (relaxed coercion layer) ─────────────────────────────────

describe("coerceParams", () => {
  test("count: 100 → 50 (clamped to max)", () => {
    expect(coerceParams({ query: "x", count: 100 }).count).toBe(50);
  });

  test("count: 0 → 1 (clamped to min)", () => {
    expect(coerceParams({ query: "x", count: 0 }).count).toBe(1);
  });

  test("count: '5' → 5 (string-to-number coercion)", () => {
    expect(coerceParams({ query: "x", count: "5" }).count).toBe(5);
  });

  test("count: undefined → 5 (default)", () => {
    expect(coerceParams({ query: "x" }).count).toBe(5);
  });

  test("count: 'abc' → 5 (default, unparseable)", () => {
    expect(coerceParams({ query: "x", count: "abc" }).count).toBe(5);
  });

  test("freshness: 'invalid' → undefined (regex mismatch)", () => {
    expect(coerceParams({ query: "x", freshness: "invalid" }).freshness).toBeUndefined();
  });

  test("freshness: 'pd' → 'pd' (valid)", () => {
    expect(coerceParams({ query: "x", freshness: "pd" }).freshness).toBe("pd");
  });

  test("safesearch: 'extreme' → 'off' (not in enum)", () => {
    expect(coerceParams({ query: "x", safesearch: "extreme" }).safesearch).toBe("off");
  });

  test("country: 'USA' → undefined (length != 2)", () => {
    expect(coerceParams({ query: "x", country: "USA" }).country).toBeUndefined();
  });

  test("country: 'US' → 'us' (lowercased)", () => {
    expect(coerceParams({ query: "x", country: "US" }).country).toBe("us");
  });

  test("query: 123 → '123' (number coerced to string)", () => {
    expect(coerceParams({ query: 123 }).query).toBe("123");
  });

  test("query: '' → '' (empty string preserved)", () => {
    expect(coerceParams({ query: "" }).query).toBe("");
  });

  test("query: undefined → '' (fallback)", () => {
    expect(coerceParams({}).query).toBe("");
  });

  test("max_tokens: 999 → 1024 (clamped to min)", () => {
    expect(coerceParams({ query: "x", max_tokens: 999 }).max_tokens).toBe(1024);
  });

  test("max_tokens: 99999 → 32768 (clamped to max)", () => {
    expect(coerceParams({ query: "x", max_tokens: 99999 }).max_tokens).toBe(32768);
  });

  test("threshold: 'weird' → 'balanced' (not in enum)", () => {
    expect(coerceParams({ query: "x", threshold: "weird" }).threshold).toBe("balanced");
  });

  test("offset: -5 → undefined (negative dropped, default omitted)", () => {
    expect(coerceParams({ query: "x", offset: -5 }).offset).toBeUndefined();
  });

  test("timeout: 500 → 1000 (clamped to min)", () => {
    expect(coerceParams({ query: "x", timeout: 500 }).timeout).toBe(1000);
  });

  test("timeout: 200000 → 120000 (clamped to max)", () => {
    expect(coerceParams({ query: "x", timeout: 200000 }).timeout).toBe(120000);
  });

  test("local: 'yes' → true (truthy string)", () => {
    expect(coerceParams({ query: "x", local: "yes" }).local).toBe(true);
  });

  test("local: 0 → false (falsy)", () => {
    expect(coerceParams({ query: "x", local: 0 }).local).toBe(false);
  });

  test("safesearch: 'OFF' → 'off' (lowercased enum match)", () => {
    expect(coerceParams({ query: "x", safesearch: "OFF" }).safesearch).toBe("off");
  });

  test("city: 'Berlin' → 'Berlin' (preserved)", () => {
    expect(coerceParams({ query: "x", city: "Berlin" }).city).toBe("Berlin");
  });

  test("max_urls: 0 → 1 (clamped to min)", () => {
    expect(coerceParams({ query: "x", max_urls: 0 }).max_urls).toBe(1);
  });

  test("freshness: '2025-01-01to2025-12-31' → preserved (valid regex)", () => {
    expect(coerceParams({ query: "x", freshness: "2025-01-01to2025-12-31" }).freshness).toBe(
      "2025-01-01to2025-12-31",
    );
  });

  test("null raw → empty-coerced defaults (no crash)", () => {
    const result = coerceParams(null);
    expect(result.query).toBe("");
    expect(result.count).toBe(5);
    expect(result.freshness).toBeUndefined();
  });
});
