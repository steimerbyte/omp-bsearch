import { describe, expect, test } from "bun:test";
import type { AgentToolResult, ToolRenderResultOptions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { ThemeColor } from "@oh-my-pi/pi-coding-agent/modes/theme/schema";
import type { Theme } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";
import type { Component } from "@oh-my-pi/pi-tui";
import bsearchExtension, {
  type BsearchDetails,
  type BsearchParams,
  coerceParams,
  extractWebSources,
  extractLlmSources,
  formatCount,
  getDomain,
  renderCall,
  renderResult,
  truncateToWidth,
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

function makeResult(
  text: string,
  opts: { error?: boolean; mode?: "llm" | "web"; response?: unknown } = {},
): AgentToolResult<BsearchDetails> {
  return {
    content: [{ type: "text", text }],
    details: {
      urls: ["https://example.com"],
      exitCode: 0,
      mode: opts.mode ?? "llm",
      response: opts.response ?? null,
    },
    isError: opts.error ?? false,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

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

// ─── Helper unit tests ─────────────────────────────────────────────────────

describe("truncateToWidth", () => {
  test("returns input unchanged when shorter than max", () => {
    expect(truncateToWidth("hello", 80)).toBe("hello");
  });

  test("truncates with ellipsis when over max", () => {
    const out = truncateToWidth("a".repeat(100), 80);
    expect(out.length).toBe(80);
    expect(out.endsWith("…")).toBe(true);
  });

  test("clamps to 80 chars in renderCall-style usage", () => {
    const long = "q".repeat(200);
    expect(truncateToWidth(long, 80).length).toBe(80);
  });

  test("returns empty string when maxWidth is 0", () => {
    expect(truncateToWidth("anything", 0)).toBe("");
  });
});

describe("getDomain", () => {
  test("extracts hostname from a standard URL", () => {
    expect(getDomain("https://example.com/path")).toBe("example.com");
  });

  test("strips leading 'www.' subdomain", () => {
    expect(getDomain("https://www.example.com/path")).toBe("example.com");
  });

  test("preserves other subdomains", () => {
    expect(getDomain("https://blog.example.com/post")).toBe("blog.example.com");
  });

  test("returns empty string for invalid URL", () => {
    expect(getDomain("not a url")).toBe("");
  });

  test("handles non-www prefix hostnames without modification", () => {
    expect(getDomain("https://api.github.com/repos")).toBe("api.github.com");
  });
});

describe("formatCount", () => {
  test("singular for count=1", () => {
    expect(formatCount("source", 1)).toBe("1 source");
  });

  test("plural for count>1", () => {
    expect(formatCount("source", 5)).toBe("5 sources");
  });

  test("zero is plural in English", () => {
    expect(formatCount("source", 0)).toBe("0 sources");
  });
});

describe("extractLlmSources", () => {
  test("returns empty array for null/undefined data", () => {
    expect(extractLlmSources(undefined)).toEqual([]);
    expect(extractLlmSources(null)).toEqual([]);
  });

  test("extracts generic grounding entries", () => {
    const sources = extractLlmSources(SAMPLE_LLM_CONTEXT);
    expect(sources.length).toBeGreaterThanOrEqual(2);
    const titles = sources.map((s) => s.title);
    expect(titles).toContain("X — long title for testing");
    expect(titles).toContain("Y");
  });

  test("joins source age arrays into a comma-separated string", () => {
    const sources = extractLlmSources(SAMPLE_LLM_CONTEXT);
    const x = sources.find((s) => s.url === "https://x.example/path");
    expect(x?.age).toBe("2 days ago");
  });

  test("includes poi as a source entry", () => {
    const sources = extractLlmSources(SAMPLE_LLM_CONTEXT);
    const poi = sources.find((s) => s.url === "https://poi.example");
    expect(poi?.title).toBe("Brandenburger Tor");
  });

  test("extracts map grounding entries by their name", () => {
    const data = {
      grounding: {
        map: [{ name: "Eiffel Tower", url: "https://map.example/eiffel", snippets: ["iconic Paris landmark"] }],
      },
    };
    const sources = extractLlmSources(data);
    expect(sources.length).toBe(1);
    expect(sources[0]!.title).toBe("Eiffel Tower");
  });
});

describe("extractWebSources", () => {
  test("returns empty for missing web.results", () => {
    expect(extractWebSources(undefined)).toEqual([]);
    expect(extractWebSources({})).toEqual([]);
  });

  test("extracts each web result with title/url/age", () => {
    const sources = extractWebSources(SAMPLE_WEB_SEARCH);
    expect(sources.length).toBe(3);
    expect(sources[0]!.title).toBe("R1");
    expect(sources[0]!.age).toBe("2 days ago");
    expect(sources[2]!.age).toBe("1 week ago");
  });

  test("age is undefined when not provided", () => {
    const sources = extractWebSources(SAMPLE_WEB_SEARCH);
    expect(sources[1]!.age).toBeUndefined();
  });
});

// ─── renderCall (native status line) ───────────────────────────────────────

describe("renderCall", () => {
  test("renders pending icon + query in quotes", () => {
    const out = flatten(renderCall({ query: "test" }, { expanded: false, isPartial: false }, stubTheme));
    expect(out).toContain("◌");          // pending icon
    expect(out).toContain("Web Search"); // title
    expect(out).toContain('"test"');
  });

  test("truncates long queries to 80 characters", () => {
    const long = "q".repeat(200);
    const out = flatten(renderCall({ query: long }, { expanded: false, isPartial: false }, stubTheme));
    // The rendered header is ` ◌ Web Search "qqqq…qqq"` — the quoted query
    // captured between the first pair of quotes must be ≤ 80 chars (truncated
    // by truncateToWidth, plus one trailing "…" if the input was longer).
    const firstQuote = out.indexOf('"');
    const secondQuote = out.indexOf('"', firstQuote + 1);
    expect(firstQuote).toBeGreaterThan(-1);
    expect(secondQuote).toBeGreaterThan(firstQuote);
    const captured = out.slice(firstQuote + 1, secondQuote);
    expect(captured.length).toBeLessThanOrEqual(80);
  });
  test("includes count=N meta when args.count is provided", () => {
    const out = flatten(
      renderCall({ query: "rust", count: 5 }, { expanded: false, isPartial: false }, stubTheme),
    );
    expect(out).toContain("5 sources");
  });

  test("shows singular '1 source' for count=1", () => {
    const out = flatten(
      renderCall({ query: "rust", count: 1 }, { expanded: false, isPartial: false }, stubTheme),
    );
    expect(out).toContain("1 source");
    expect(out).not.toContain("1 sources");
  });

  test("includes freshness meta when set", () => {
    const out = flatten(
      renderCall({ query: "rust", freshness: "pw" }, { expanded: false, isPartial: false }, stubTheme),
    );
    expect(out).toContain("fresh=pw");
  });

  test("renders empty query gracefully", () => {
    const out = flatten(renderCall({ query: "" }, { expanded: false, isPartial: false }, stubTheme));
    expect(out).toContain("Web Search");
    expect(out).toContain("◌");
  });
});

// ─── renderResult (native sectioned box layout) ────────────────────────────

describe("renderResult", () => {
  const opts: ToolRenderResultOptions = { expanded: false, isPartial: false };
  const expandedOpts: ToolRenderResultOptions = { expanded: true, isPartial: false };

  test("renders header with Web Search title + provider + source count", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    // Box frame top border
    expect(out).toContain("╭─");
    // Header text: status icon + title + provider label + count
    expect(out).toContain("Web Search");
    expect(out).toContain("Brave LLM Context");
    expect(out).toMatch(/\d+ sources?/);
  });

  test("includes query section when args.query is provided", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "rust async" }));
    expect(out).toContain("Query");
    expect(out).toContain("rust async");
  });

  test("omits query section when args.query is missing", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).not.toContain("Query");
  });

  test("renders Sources section with tree branches for each source", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("Sources");
    expect(out).toMatch(/├─/);
    expect(out).toContain("x.example");
    expect(out).toContain("y.example");
  });

  test("includes domain in parentheses and age on the source line", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toMatch(/\(x\.example\)/);
    expect(out).toContain("2 days ago");
  });

  test("renders Metadata section with Provider line", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("Metadata");
    expect(out).toContain("Provider:");
  });

  test("wraps content in box frame with bottom border", () => {
    const result = makeResult("", { mode: "llm", response: SAMPLE_LLM_CONTEXT });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("╭─");
    expect(out).toContain("│");
    expect(out).toMatch(/╰─+╯/);
  });

  test("error result renders error panel with ✗ marker", () => {
    const result = makeResult("network error", { error: true });
    const out = flatten(renderResult(result, opts, stubTheme));
    expect(out).toContain("✗");
    expect(out).toContain("Error:");
    expect(out).toContain("network error");
  });

  test("zero sources → warning icon + '0 sources' meta", () => {
    const emptyResp = { grounding: {} };
    const result = makeResult("", { mode: "llm", response: emptyResp });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("⚠");
    expect(out).toContain("0 sources");
  });

  test("web mode renders Web Search provider label", () => {
    const result = makeResult("", { mode: "web", response: SAMPLE_WEB_SEARCH });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("Brave Web Search");
  });

  test("web mode extracts sources from web.results (not from content text)", () => {
    const result = makeResult("", { mode: "web", response: SAMPLE_WEB_SEARCH });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toContain("R1");
    expect(out).toContain("r1.example");
    expect(out).toContain("r3.example");
  });

  test("expanded mode keeps all sources visible (no truncation of small lists)", () => {
    const result = makeResult("", { mode: "web", response: SAMPLE_WEB_SEARCH });
    const collapsedOut = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    const expandedOut = flatten(renderResult(result, expandedOpts, stubTheme, { query: "test" }));
    // Both renderings include all 3 sources; expanded has no "+N more sources" hint.
    expect(expandedOut).toContain("R1");
    expect(expandedOut).toContain("R2");
    expect(expandedOut).toContain("R3");
    expect(expandedOut).not.toMatch(/\+\d+ sources? more/);
    expect(collapsedOut).toContain("R1");
  });

  test("collapsed mode truncates source list with '+N more sources'", () => {
    const big = {
      web: {
        results: Array.from({ length: 20 }, (_, i) => ({
          title: `R${i}`,
          url: `https://r${i}.example`,
          description: "d",
        })),
      },
    };
    const result = makeResult("", { mode: "web", response: big });
    const out = flatten(renderResult(result, opts, stubTheme, { query: "test" }));
    expect(out).toMatch(/\+\d+ sources? more/);
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
