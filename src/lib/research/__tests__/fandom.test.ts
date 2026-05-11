import { describe, expect, it } from "vitest";
import { fetchFandomPage } from "../fandom";

const PROSE_HTML = `<!DOCTYPE html>
<html><head><script>var x = 1;</script><style>body{}</style><title>Test</title></head>
<body>
<aside class="page-header__categories"><a>cat1</a></aside>
<nav class="navigation">menu items here</nav>
<div class="portable-infobox">Infobox content that should be dropped</div>
<div class="content">
  <h1>Cowboy Bebop</h1>
  <p>Cowboy Bebop is a 1998 Japanese neo-noir science fiction anime television series.</p>
  <p>The series follows the lives of a traveling bounty-hunting crew aboard the spaceship Bebop. Mainline characters include Spike Spiegel, Jet Black, Faye Valentine, Edward and Ein the data dog. The story takes place in 2071, after the hyperspace gate accident.</p>
  <p>Themes include existentialism, loneliness, and the cost of one's past — explored through jazz-inflected episodic stories that ultimately converge on Spike's history with the Red Dragon Syndicate.</p>
</div>
<div class="references">[1] [2] [3]</div>
<footer class="footer">site footer</footer>
</body></html>`;

function mockFetch(opts: { status?: number; body?: string }): typeof fetch {
  return (async () =>
    ({
      ok: (opts.status ?? 200) < 400,
      status: opts.status ?? 200,
      url: "https://cowboybebop.fandom.com/wiki/Some_Page",
      text: async () => opts.body ?? "",
    }) as unknown as Response) as unknown as typeof fetch;
}

describe("fetchFandomPage", () => {
  it("strips HTML and returns prose", async () => {
    const result = await fetchFandomPage("cowboy-bebop", {
      fetchFn: mockFetch({ body: PROSE_HTML }),
    });
    expect(result).not.toBeNull();
    expect(result?.prose).toContain("neo-noir science fiction");
    expect(result?.prose).toContain("Spike Spiegel");
    // Script content + footer + nav should be gone.
    expect(result?.prose).not.toContain("var x = 1");
    expect(result?.prose).not.toContain("site footer");
    expect(result?.prose).not.toContain("menu items");
    // Infobox is dropped via the class regex.
    expect(result?.prose).not.toContain("Infobox content");
  });

  it("returns null on HTTP non-2xx", async () => {
    const result = await fetchFandomPage("missing-slug", {
      fetchFn: mockFetch({ status: 404 }),
    });
    expect(result).toBeNull();
  });

  it("returns null on very-short prose (likely stub page)", async () => {
    const result = await fetchFandomPage("stub", {
      fetchFn: mockFetch({ body: "<html><body><p>tiny.</p></body></html>" }),
    });
    expect(result).toBeNull();
  });

  it("returns null when slug is empty after normalization", async () => {
    const result = await fetchFandomPage("---", {
      fetchFn: mockFetch({ body: PROSE_HTML }),
    });
    expect(result).toBeNull();
  });

  it("decodes common HTML entities", async () => {
    const result = await fetchFandomPage("decode-test", {
      fetchFn: mockFetch({
        body: `<html><body><div><p>Spike&#39;s past &amp; future. Jet&nbsp;Black is &quot;reliable&quot;. ${"x".repeat(300)}</p></div></body></html>`,
      }),
    });
    expect(result).not.toBeNull();
    expect(result?.prose).toContain("Spike's past & future");
    expect(result?.prose).toContain('Jet Black is "reliable"');
  });

  it("returns null when fetch throws (timeout / network error)", async () => {
    const throwingFetch: typeof fetch = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const result = await fetchFandomPage("network-fail", { fetchFn: throwingFetch });
    expect(result).toBeNull();
  });
});
