import { beforeAll, describe, expect, test } from "bun:test";
import type { AgentToolResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import type { Component } from "@oh-my-pi/pi-tui";
import {
  type BsearchDetails,
  type BsearchParams,
  coerceParams,
  renderResult,
  renderSearchResult,
} from "./bsearch.js";
import { initThemeSync } from "@oh-my-pi/pi-coding-agent/modes/theme/theme";

// OMP's `Markdown` component (and `getMarkdownTheme()`) read the global
// `theme` instance — the runtime harness initializes it before invoking
// `renderResult`. Tests don't go through it, so we initialize the theme
// ourselves once for the whole suite.
beforeAll(() => {
  initThemeSync();
});

function flatten(c: Component | undefined): string {
  if (!c) return "";
  const t = c as unknown as { getText?: () => string; render?: (w: number) => readonly string[] };
  if (typeof t.getText === "function") return t.getText();
  if (typeof t.render === "function") return [...t.render(400)].join("\n");
  return "";
}

function makeResult(
  opts: { error?: boolean; mode?: "llm" | "web"; response?: unknown } = {},
): AgentToolResult<BsearchDetails> {
  return {
    content: [{ type: "text", text: "" }],
    details: {
      urls: [],
      exitCode: 0,
      mode: opts.mode ?? "llm",
      response: opts.response ?? null,
    },
    isError: opts.error ?? false,
  };
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

const LLM_WITH_ANSWER = {
  answer: "The capital of France is Paris.",
  follow_up_questions: ["What is the population of Paris?"],
  grounding: {
    generic: [
      { title: "Wikipedia", url: "https://w.example/wiki", snippets: ["# mess"] },
      { title: "Britannica", url: "https://b.example/paris", snippets: ["more mess"] },
    ],
  },
  sources: {
    "https://w.example/wiki": {
      title: "France — Wikipedia",
      hostname: "w.example",
      age: ["Tuesday, August 04, 2026", "2026-08-04", "31 days ago", "2026-08-04T11:17:17Z"],
      snippet: "France is a country in Europe. Its capital is Paris.",
    },
    "https://b.example/paris": {
      title: "Paris | Britannica",
      hostname: "b.example",
      age: ["569 days ago"],
      snippet: "Paris, city and capital of France.",
    },
    // orphan: present in `sources` but NOT in `grounding.generic[]` → must
    // not be rendered.
    "https://orphan.example": {
      title: "Orphan",
      hostname: "orphan.example",
      snippet: "should not appear",
    },
  },
};

const LLM_NO_ANSWER = {
  grounding: {
    generic: [
      { title: "G1", url: "https://g1.example", snippets: ["x"] },
      { title: "G2", url: "https://g2.example", snippets: ["y"] },
    ],
  },
  sources: {
    "https://g1.example": { title: "First", hostname: "g1.example", snippet: "first snippet" },
    "https://g2.example": { title: "Second", hostname: "g2.example", snippet: "second snippet" },
  },
};

const WEB_RESPONSE = {
  web: {
    results: [
      { title: "R1", url: "https://r1.example", description: "first description", age: "2 days ago", meta_url: { hostname: "r1.example" } },
      { title: "R2", url: "https://r2.example", description: "second description", meta_url: { hostname: "r2.example" } },
      { title: "R3", url: "https://r3.example", description: "third description", age: "1 week ago", meta_url: { hostname: "r3.example" } },
    ],
    total: { results: 42 },
  },
};

// ─── renderSearchResult — LLM mode ─────────────────────────────────────────

describe("renderSearchResult — LLM mode", () => {
  test("renders Query + Answer + Sources sections when answer is present", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "capital of france" });
    expect(out).toContain("# Web Search (Brave LLM Context)");
    expect(out).toContain("## Query");
    expect(out).toContain("capital of france");
    expect(out).toContain("## Answer");
    expect(out).toContain("The capital of France is Paris.");
    expect(out).toContain("## Sources");
  });

  test("omits Answer section when answer is missing", () => {
    const out = renderSearchResult("llm", LLM_NO_ANSWER, { query: "x" });
    expect(out).not.toContain("## Answer");
    expect(out).toContain("## Sources");
  });

  test("omits Answer section when answer is empty/whitespace", () => {
    const out = renderSearchResult(
      "llm",
      { ...LLM_NO_ANSWER, answer: "   \n\t  " },
      { query: "x" },
    );
    expect(out).not.toContain("## Answer");
  });

  test("uses sources[url].snippet (clean), not grounding.generic[].snippets[]", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).toContain("France is a country in Europe. Its capital is Paris.");
    expect(out).toContain("Paris, city and capital of France.");
    // The messy "# mess" / "more mess" snippets from grounding.generic[].snippets[]
    // must NOT appear in the rendered output.
    expect(out).not.toContain("# mess");
    expect(out).not.toContain("more mess");
  });

  test("renders hostname · age meta line between link and snippet", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).toContain("[France — Wikipedia](https://w.example/wiki)");
    expect(out).toContain("w.example");
    // Hostname + age rendered together with the · separator. The first
    // non-empty element of sources[url].age[] is used as-is.
    expect(out).toMatch(/w\.example\s*·\s*Tuesday, August 04, 2026/);
  });

  test("source order matches grounding.generic[] array order", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    const idxWiki = out.indexOf("France — Wikipedia");
    const idxBrit = out.indexOf("Paris \\| Britannica");
    expect(idxWiki).toBeGreaterThan(-1);
    expect(idxBrit).toBeGreaterThan(idxWiki);
  });

  test("excludes orphan sources (in sources map but not in grounding.generic[])", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).not.toContain("Orphan");
    expect(out).not.toContain("orphan.example");
  });

  test("snippet renders as blockquote under list bullet", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).toMatch(/>\s+France is a country in Europe/);
  });

  test("uses first non-empty entry of sources[url].age[] array as-is", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    // First element is "Tuesday, August 04, 2026" — that string must appear
    // (we use age[0] verbatim).
    expect(out).toContain("Tuesday, August 04, 2026");
    // The "31 days ago" form is the THIRD element, so it must NOT appear.
    expect(out).not.toContain("31 days ago");
  });

  test("escapes unsafe markdown characters in title", () => {
    const data = {
      grounding: { generic: [{ title: "T", url: "https://x.example" }] },
      sources: {
        "https://x.example": {
          title: "Pipe | in title and [brackets] and *star*",
          hostname: "x.example",
          snippet: "ok",
        },
      },
    };
    const out = renderSearchResult("llm", data, { query: "x" });
    expect(out).toContain("Pipe \\| in title");
    expect(out).toContain("\\[brackets\\]");
    expect(out).toContain("\\*star\\*");
  });

  test("escapes leading '>' in snippet so blockquote nesting isn't broken", () => {
    const data = {
      grounding: { generic: [{ title: "T", url: "https://x.example" }] },
      sources: {
        "https://x.example": {
          title: "T",
          hostname: "x.example",
          snippet: "> nested quote would break list rendering",
        },
      },
    };
    const out = renderSearchResult("llm", data, { query: "x" });
    // The leading `>` is escaped so the blockquote stays a child of the
    // list bullet, not a sibling/parent blockquote.
    expect(out).toContain("\\> nested quote");
    expect(out).not.toMatch(/^>\s+> nested quote/m);
  });

  test("snippet text is preserved verbatim (mid-line '>' and '|' are not escaped)", () => {
    const data = {
      grounding: { generic: [{ title: "T", url: "https://x.example" }] },
      sources: {
        "https://x.example": {
          title: "T",
          hostname: "x.example",
          snippet: "a | b > c",
        },
      },
    };
    const out = renderSearchResult("llm", data, { query: "x" });
    // Mid-line characters pass through; only leading `>` triggers escaping.
    expect(out).toContain("a | b > c");
  });

  test("renders Sources heading without box characters", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).not.toMatch(/╭|╮|╰|╯/);
    expect(out).not.toContain("│");
  });
});

// ─── renderSearchResult — Web mode ──────────────────────────────────────────

describe("renderSearchResult — Web mode", () => {
  test("renders sources as markdown bullet list with title-link", () => {
    const out = renderSearchResult("web", WEB_RESPONSE, { query: "x" });
    expect(out).toContain("# Web Search (Brave Web Search)");
    expect(out).toContain("## Sources");
    expect(out).toContain("- [R1](https://r1.example)");
    expect(out).toContain("- [R2](https://r2.example)");
    expect(out).toContain("- [R3](https://r3.example)");
  });

  test("hostname · age rendered between link and snippet", () => {
    const out = renderSearchResult("web", WEB_RESPONSE, { query: "x" });
    expect(out).toMatch(/\[R1\]\(https:\/\/r1\.example\)[^\n]*r1\.example\s*·\s*2 days ago/);
    expect(out).toMatch(/\[R3\]\(https:\/\/r3\.example\)[^\n]*r3\.example\s*·\s*1 week ago/);
  });

  test("description (clean text) appears as snippet", () => {
    const out = renderSearchResult("web", WEB_RESPONSE, { query: "x" });
    expect(out).toContain("first description");
    expect(out).toContain("second description");
    expect(out).toContain("third description");
  });

  test("appends '…and N more results' when total > rendered count", () => {
    const out = renderSearchResult("web", WEB_RESPONSE, { query: "x" });
    expect(out).toContain("…and 39 more results");
  });

  test("renders Query section in web mode when query is provided", () => {
    const out = renderSearchResult("web", WEB_RESPONSE, { query: "x" });
    expect(out).toContain("## Query");
    expect(out).not.toContain("## Answer");
  });
});

describe("renderResult — Markdown component wrapper", () => {
  test("LLM success path returns a Component rendering the search title and sections", () => {
    const result = makeResult({ mode: "llm", response: LLM_WITH_ANSWER });
    const out = flatten(renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "capital of france" }));
    // The Markdown component strips leading `#` / `##` markers and styles the
    // heading text. The plain text content still appears.
    expect(out).toContain("Web Search");
    expect(out).toContain("Answer");
    expect(out).toContain("The capital of France is Paris.");
    expect(out).toContain("Sources");
  });

  test("LLM success path adds ANSI escapes for syntax highlighting (no plain Text)", () => {
    const result = makeResult({ mode: "llm", response: LLM_WITH_ANSWER });
    const out = flatten(renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "x" }));
    // The Markdown component must inject ANSI escapes for heading/link/etc.
    expect(out).toContain("\u001b[");
  });

  test("renderResult never wraps the markdown in a box frame", () => {
    const result = makeResult({ mode: "llm", response: LLM_WITH_ANSWER });
    const out = flatten(renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "x" }));
    expect(out).not.toMatch(/╭|╮|╰|╯/);
    expect(out).not.toContain("│");
  });

  test("error path renders a plain 'Error: …' Text", () => {
    const errResult: AgentToolResult<BsearchDetails> = {
      content: [{ type: "text", text: "network unreachable" }],
      details: { urls: [], exitCode: null, mode: "llm", response: null },
      isError: true,
    };
    const out = flatten(renderResult(errResult, { expanded: false, isPartial: false }, {} as never));
    expect(out).toContain("Error: network unreachable");
    expect(out).not.toMatch(/╭|╮|╰|╯/);
  });

  test("web mode renderResult pulls from result.details.response", () => {
    const result = makeResult({ mode: "web", response: WEB_RESPONSE });
    const out = flatten(renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "x" }));
    // The Markdown component renders list bullets with ANSI styling — the
    // plain text "R1" / "R3" survives and so does the "more results" footer.
    expect(out).toContain("R1");
    expect(out).toContain("https://r1.example");
    expect(out).toContain("R3");
    expect(out).toContain("…and 39 more results");
  });
});

// ─── coerceParams (regression — unchanged behavior) ─────────────────────────

describe("coerceParams", () => {
  test("count: 100 → 50 (clamped to max)", () => {
    expect(coerceParams({ query: "x", count: 100 }).count).toBe(50);
  });

  test("count: 0 → 5 (clamped to min floor)", () => {
    expect(coerceParams({ query: "x", count: 0 }).count).toBe(5);
  });

  test("count: '5' → 5 (string-to-number coercion)", () => {
    expect(coerceParams({ query: "x", count: "5" }).count).toBe(5);
  });

  test("count: undefined → 5 (default)", () => {
    expect(coerceParams({ query: "x" }).count).toBe(5);
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

  test("max_urls: 0 → 5 (clamped to min floor)", () => {
    expect(coerceParams({ query: "x", max_urls: 0 }).max_urls).toBe(5);
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

// ─── coerceParams — v2.5.0 count / max_urls floor (5) ──────────────────────

describe("coerceParams — count / max_urls floor (5)", () => {
  test("count: 0 → 5 (clamped up to floor)", () => {
    expect(coerceParams({ query: "x", count: 0 }).count).toBe(5);
  });

  test("count: 3 → 5 (clamped up to floor)", () => {
    expect(coerceParams({ query: "x", count: 3 }).count).toBe(5);
  });

  test("count: 4 → 5 (clamped up to floor)", () => {
    expect(coerceParams({ query: "x", count: 4 }).count).toBe(5);
  });

  test("count: '1' → 5 (string coerced + clamped up to floor)", () => {
    expect(coerceParams({ query: "x", count: "1" }).count).toBe(5);
  });

  test("count: undefined → 5 (default floor)", () => {
    expect(coerceParams({ query: "x" }).count).toBe(5);
  });

  test("count: 5 → 5 (exact floor preserved)", () => {
    expect(coerceParams({ query: "x", count: 5 }).count).toBe(5);
  });

  test("count: 7 → 7 (above floor preserved)", () => {
    expect(coerceParams({ query: "x", count: 7 }).count).toBe(7);
  });

  test("max_urls: 2 → 5 (clamped up to floor)", () => {
    expect(coerceParams({ query: "x", max_urls: 2 }).max_urls).toBe(5);
  });

  test("max_urls: undefined → 5 (default floor)", () => {
    expect(coerceParams({ query: "x" }).max_urls).toBe(5);
  });
});

// ─── Markdown output integration (v2.5.0) ──────────────────────────────────

describe("Markdown output", () => {
  test("renderSearchResult output contains the canonical section markers", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "capital of france" });
    expect(out).toContain("## Query");
    expect(out).toContain("## Answer");
    expect(out).toContain("## Sources");
  });

  test("renderSearchResult renders links as [Title](url)", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    expect(out).toContain("[France — Wikipedia](https://w.example/wiki)");
    expect(out).toContain("[Paris \\| Britannica](https://b.example/paris)");
  });

  test("Markdown includes sources[url].snippet (clean text), not raw grounding snippets", () => {
    const out = renderSearchResult("llm", LLM_WITH_ANSWER, { query: "x" });
    // Clean snippet text from sources[url].snippet
    expect(out).toContain("France is a country in Europe. Its capital is Paris.");
    expect(out).toContain("Paris, city and capital of France.");
    // Messy grounding.generic[].snippets[] must NOT appear
    expect(out).not.toContain("# mess");
    expect(out).not.toContain("more mess");
  });

  test("renderResult returns a Markdown Component that renders to non-empty lines", () => {
    const result = makeResult({ mode: "llm", response: LLM_WITH_ANSWER });
    const c = renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "x" });
    expect(c).toBeDefined();
    // The render() path is the only consumer-facing surface — render the
    // component to a wide terminal and verify it yields strings, no throw.
    const out = flatten(c);
    expect(typeof out).toBe("string");
    expect(out.length).toBeGreaterThan(0);
    // Sanity: the rendered markdown must include the section text — the
    // Markdown component strips the leading `#` markers, so we match the
    // plain heading text instead.
    expect(out).toContain("Sources");
    expect(out).toContain("Web Search");
  });

  test("renderResult output contains canonical markdown sections even after rendering", () => {
    const result = makeResult({ mode: "llm", response: LLM_WITH_ANSWER });
    const out = flatten(renderResult(result, { expanded: false, isPartial: false }, {} as never, { query: "capital of france" }));
    expect(out).toContain("Web Search");
    expect(out).toContain("Query");
    expect(out).toContain("Answer");
    expect(out).toContain("Sources");
    // Clean snippet text from sources[url].snippet must survive the Markdown render pass
    expect(out).toContain("France is a country in Europe. Its capital is Paris.");
  });
});
// ─── Module exports (regression) ────────────────────────────────────────────

describe("module exports", () => {
  test("renderSearchResult is exported as a function", () => {
    expect(typeof renderSearchResult).toBe("function");
  });

  test("renderResult is exported as a function", () => {
    expect(typeof renderResult).toBe("function");
  });

  test("BsearchParams and BsearchDetails are exported as types", () => {
    // Type-only — just verify they're exported at the value level (BsearchParams is a type alias).
    const p: BsearchParams = { query: "x" };
    expect(p.query).toBe("x");
    const d: BsearchDetails = { urls: [], exitCode: 0, mode: "llm", response: null };
    expect(d.mode).toBe("llm");
  });
});
