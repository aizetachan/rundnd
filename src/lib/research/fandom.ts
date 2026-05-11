/**
 * Single-page Fandom wiki fetcher. Used by Path A profile research to
 * gather prose context (tone, character voice fragments, world detail)
 * that AniList's structured metadata doesn't carry.
 *
 * Acknowledged-fragile. No anti-bot evasion, no link following, no
 * retry on 4xx — if Fandom 403s us or the slug-to-subdomain heuristic
 * misses, we return null and Path A falls back to AniList-only. The
 * eval harness measures how often this fires; if Fandom-null is too
 * common, sub 6's follow-up adds a curated subdomain map.
 *
 * The slug-to-subdomain heuristic: lowercase + strip non-alphanum +
 * concatenate. Works for "cowboy-bebop" → cowboybebop.fandom.com,
 * "solo-leveling" → sololeveling.fandom.com. Fails for cases where
 * Fandom's actual wiki has a different short name (e.g. "Naruto" →
 * narutopedia, not naruto.fandom.com).
 */

interface FetchFandomOptions {
  /** Override the default fetch (testing). */
  fetchFn?: typeof fetch;
  /** Override the AbortSignal timeout (default 8000ms). */
  timeoutMs?: number;
}

export interface FandomResult {
  /** The URL that was successfully fetched. */
  url: string;
  /** Plain-text prose extracted from the page. Capped to ~12000 chars
   *  to keep the downstream LLM parse pass cheap. */
  prose: string;
}

const DEFAULT_TIMEOUT_MS = 8000;
const MAX_PROSE_CHARS = 12000;

function slugToSubdomain(slug: string): string {
  return slug.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Convert the kebab-cased input slug to Fandom's wiki page convention:
 * each word capitalized, joined by underscores. "cowboy-bebop" →
 * "Cowboy_Bebop". Picks up the canonical main page for most IPs; the
 * eval harness needs deterministic behavior here.
 */
function slugToWikiPage(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("_");
}

/**
 * Strip Fandom HTML to readable prose.
 *
 * Order matters here — we drop script/style first, then nav/sidebar
 * containers (Fandom's own classes), then collapse HTML tags. Final
 * pass normalizes whitespace + caps length.
 */
function stripHtml(html: string): string {
  let out = html;
  // Drop entire <script> and <style> blocks (with their contents).
  out = out.replace(/<script[\s\S]*?<\/script>/gi, "");
  out = out.replace(/<style[\s\S]*?<\/style>/gi, "");
  // Drop Fandom-specific nav/sidebar/footer containers (class regex).
  out = out.replace(
    /<(div|aside|nav|footer|header|section)\b[^>]*\bclass="[^"]*?(navigation|sidebar|footer|portable-infobox|article-categories|page-header__categories|toc|references|hatnote)[^"]*"[^>]*>[\s\S]*?<\/\1>/gi,
    "",
  );
  // Drop bare <footer> and <header> elements regardless of class.
  out = out.replace(/<footer\b[^>]*>[\s\S]*?<\/footer>/gi, "");
  out = out.replace(/<header\b[^>]*>[\s\S]*?<\/header>/gi, "");
  // Replace common block tags with newlines BEFORE stripping all tags.
  out = out.replace(/<(p|br|h[1-6]|li|div)\b[^>]*>/gi, "\n");
  out = out.replace(/<\/(p|h[1-6]|li|div)>/gi, "\n");
  // Strip remaining tags.
  out = out.replace(/<[^>]+>/g, "");
  // Decode the most common HTML entities (Fandom returns these often).
  out = out
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
  // Normalize whitespace.
  out = out
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return out.slice(0, MAX_PROSE_CHARS);
}

/**
 * Fetch the Fandom main-page prose for an IP. Returns null on any
 * failure (404 / 403 / timeout / parse) so callers can degrade
 * gracefully.
 *
 * `slug` is the same kebab-cased slug used by `normalizeAnimeResearchOutput`
 * (e.g. "cowboy-bebop"). The function tries `<subdomain>.fandom.com`
 * where subdomain is `slugToSubdomain(slug)`.
 */
export async function fetchFandomPage(
  slug: string,
  options: FetchFandomOptions = {},
): Promise<FandomResult | null> {
  const subdomain = slugToSubdomain(slug);
  if (!subdomain) return null;
  const page = slugToWikiPage(slug);
  if (!page) return null;
  const url = `https://${subdomain}.fandom.com/wiki/${page}`;
  // We hit the canonical main page (slug title-cased) rather than
  // Special:Random. The eval harness depends on deterministic Fandom
  // content per IP — a randomized page would attribute parse-quality
  // variance to the path under test instead of the source material.
  // Trade-off: when the IP's main page is a stub or redirect, we get
  // less prose. That's caught downstream (research_confidence drops).

  const fetchFn = options.fetchFn ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const response = await fetchFn(url, {
      headers: {
        "User-Agent": "AIDM-profile-research/1.0",
        Accept: "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    }).finally(() => clearTimeout(timer));

    if (!response.ok) return null;
    const html = await response.text();
    const prose = stripHtml(html);
    if (prose.length < 200) return null;
    return { url: response.url || url, prose };
  } catch {
    return null;
  }
}
