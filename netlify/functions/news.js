import Parser from "rss-parser";
import * as cheerio from "cheerio";

import sourcesCfg from "./sources.json" assert { type: "json" };

const parser = new Parser({
  timeout: 12000,
  headers: { "User-Agent": "InsightsDashboardBot/1.0 (+Netlify Function)" }
});

const CACHE_TTL_MS = 10 * 60 * 1000;
let CACHE = { ts: 0, payload: null };

async function fetchText(url, timeoutMs = 9000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

function normaliseItem({ title, url, summary, publishedAt, source, category }) {
  return {
    id: (url || `${source}-${title}`).toLowerCase(),
    title: (title || "").trim(),
    url,
    source,
    summary: (summary || "").replace(/\s+/g, " ").trim().slice(0, 320),
    publishedAt,
    category
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = `${(it.url || "").toLowerCase()}|${(it.title || "").toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Your existing categories
function classify(defaultCategory, title, summary) {
  const text = `${title} ${summary}`.toLowerCase();

  const has = (...words) => words.some((w) => text.includes(w));

  if (has("student", "university", "maintenance loan", "freshers")) return "Student";
  if (has("farm", "farming", "rural", "agri", "livestock")) return "Rural";
  if (has("motor", "car", "van", "driver", "fleet", "ev", "theft")) return "Motor";
  if (has("home", "property", "buildings", "contents", "flood", "subsidence")) return "Home";
  if (has("life insurance", "income protection", "health", "medical", "nhs")) return "Life & Health";
  if (has("broker", "underwriting", "lloyd", "reinsurance", "claims", "fca", "pra", "abi", "biba")) return "Trade";

  return defaultCategory || "Business";
}

// --------------------
// SCRAPER: Hiscox UK business-blog
// --------------------
const HISCOX_CATEGORY_SLUGS = new Set([
  "brand-and-marketing",
  "finance-and-legal",
  "starting-up",
  "customers-and-clients",
  "small-business-stories",
  "data-and-tech",
  "growth-and-operations",
  "wellbeing-and-workplace",
  "authors"
]);

function isLikelyHiscoxArticlePath(pathname) {
  // We only want /business-blog/{slug} where slug is NOT a known category
  // Article examples show this URL shape. [2](https://www.hiscox.co.uk/business-blog/small-business-how-to-make-a-website)[3](https://www.hiscox.co.uk/business-blog/how-to-start-a-business-guide)
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length !== 2) return false;
  if (parts[0] !== "business-blog") return false;
  if (HISCOX_CATEGORY_SLUGS.has(parts[1])) return false;
  return true;
}

function parseHiscoxPublishedDate(text) {
  // Hiscox articles show dates like "March 31st, 2026" etc. [2](https://www.hiscox.co.uk/business-blog/small-business-how-to-make-a-website)[3](https://www.hiscox.co.uk/business-blog/how-to-start-a-business-guide)
  const m = text.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(st|nd|rd|th)?,\s+\d{4}\b/
  );
  return m ? m[0] : null;
}

async function scrapeHiscoxBusinessBlog(listUrl) {
  const html = await fetchText(listUrl, 9000);
  const $ = cheerio.load(html);

  const articleUrls = new Set();

  $("a[href]").each((_, a) => {
    const href = $(a).attr("href");
    if (!href) return;

    let u;
    try {
      u = new URL(href, listUrl);
    } catch {
      return;
    }

    if (u.hostname !== "www.hiscox.co.uk") return;
    if (!isLikelyHiscoxArticlePath(u.pathname)) return;

    articleUrls.add(u.toString());
  });

  // Pull a sensible number so we don’t hammer the site
  const urls = Array.from(articleUrls).slice(0, 25);

  // Fetch each article page and extract title/date/summary
  const items = [];
  for (const url of urls) {
    try {
      const articleHtml = await fetchText(url, 9000);
      const $$ = cheerio.load(articleHtml);

      const title =
        $$("meta[property='og:title']").attr("content") ||
        $$("title").text() ||
        $$("h1").first().text();

      const description =
        $$("meta[name='description']").attr("content") ||
        $$("meta[property='og:description']").attr("content") ||
        "";

      const bodyText = $$("body").text().replace(/\s+/g, " ").trim();
      const publishedHuman = parseHiscoxPublishedDate(bodyText);

      // We store the human date if we can’t reliably convert to ISO (keeps it honest)
      const publishedAt = publishedHuman || null;

      items.push(
        normaliseItem({
          title,
          url,
          summary: description,
          publishedAt,
          source: "Hiscox – Knowledge Centre (Business Blog)",
          category: "Business"
        })
      );
    } catch {
      // skip single-article failure
    }
  }

  return items;
}

// --------------------
// MAIN HANDLER
// --------------------
export const handler = async () => {
  const now = Date.now();
  if (CACHE.payload && now - CACHE.ts < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
      body: JSON.stringify({ ...CACHE.payload, cached: true })
    };
  }

  const diagnostics = [];
  const allItems = [];

  for (const source of sourcesCfg.sources || []) {
    const t0 = Date.now();
    try {
      // 1) SCRAPED sources
      if (source.sourceType === "scraped" && source.siteUrl) {
        if (source.siteUrl === "https://www.hiscox.co.uk/business-blog") {
          const scraped = await scrapeHiscoxBusinessBlog(source.siteUrl);
          // Apply classifier after scrape (optional)
          for (const it of scraped) {
            it.category = classify(source.defaultCategory, it.title, it.summary);
            allItems.push(it);
          }
          diagnostics.push({ source: source.name, ok: true, kind: "scraped", ms: Date.now() - t0, items: scraped.length });
          continue;
        }

        throw new Error("Scraper not implemented for this siteUrl");
      }

      // 2) RSS sources
      if (source.feedUrl) {
        const xml = await fetchText(source.feedUrl, 9000);
        const feed = await parser.parseString(xml);
        const items = (feed.items || []).slice(0, 25);

        let kept = 0;
        for (const item of items) {
          const title = item.title || "";
          const url = item.link || "";
          const publishedAt = item.isoDate || item.pubDate || null;
          const summary = item.contentSnippet || item.summary || "";

          if (!title || !url) continue;

          const category = classify(source.defaultCategory, title, summary);

          allItems.push(
            normaliseItem({
              title,
              url,
              summary,
              publishedAt,
              source: source.name,
              category
            })
          );
          kept++;
        }

        diagnostics.push({ source: source.name, ok: true, kind: "rss", ms: Date.now() - t0, items: kept });
        continue;
      }

      // If neither feedUrl nor scrape
      diagnostics.push({ source: source.name, ok: false, ms: Date.now() - t0, error: "No feedUrl or supported scraper" });
    } catch (err) {
      diagnostics.push({ source: source.name, ok: false, ms: Date.now() - t0, error: err.message });
    }
  }

  const cleaned = dedupe(allItems).sort((a, b) => {
    const da = a.publishedAt ? Date.parse(a.publishedAt) : 0;
    const db = b.publishedAt ? Date.parse(b.publishedAt) : 0;
    return db - da;
  });

  const payload = { items: cleaned, diagnostics, cached: false };
  CACHE = { ts: Date.now(), payload };

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(payload)
  };
};
