import Parser from "rss-parser";
import * as cheerio from "cheerio";
import sourcesCfg from "./sources.json" assert { type: "json" };

const parser = new Parser({
  timeout: 12000,
  headers: { "User-Agent": "MarketInsightsDashboard/1.1 (+Netlify Function)" }
});

// -----------------------------
// Simple in-memory cache (warm functions benefit massively)
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
let CACHE = { ts: 0, payload: null };

// -----------------------------
// Helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, timeoutMs = 4500) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } finally {
    clearTimeout(id);
  }
}

function normaliseItem(item, sourceName) {
  const publishedAt = item.isoDate || item.pubDate || item.published || null;
  const summaryRaw = (item.contentSnippet || item.summary || item.content || "") + "";

  return {
    id: item.guid || item.id || item.link || `${sourceName}-${item.title}`,
    title: (item.title || "").trim(),
    url: item.link,
    source: sourceName,
    summary: summaryRaw.replace(/\s+/g, " ").trim().slice(0, 320),
    publishedAt
  };
}

function dedupe(items) {
  const seen = new Set();
  return items.filter((it) => {
    const key = `${it.url || ""}|${it.title || ""}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// -----------------------------
// Category classifier (your exact UI categories)
function classifyCategory(defaultCategory, title, summary) {
  const text = `${title} ${summary}`.toLowerCase();

  const has = (...words) => words.some((w) => text.includes(w));

  // Student
  if (has("student", "students", "university", "uni ", "maintenance loan", "student loan", "freshers", "accommodation", "tenancy deposit")) {
    return "Student";
  }

  // Rural
  if (has("farm", "farming", "farmer", "livestock", "arable", "dairy", "poultry", "rural", "agri", "agriculture")) {
    return "Rural";
  }

  // Motor
  if (has("motor", "car", "vehicle", "van", "driver", "fleet", "ev", "electric vehicle", "repair", "bodyshop", "collision", "theft", "fronting", "ghost broker", "crash for cash", "telematics")) {
    return "Motor";
  }

  // Home
  if (has("home", "property", "buildings", "contents", "house", "landlord", "tenant", "flood", "subsidence", "storm", "roof", "fire safety")) {
    return "Home";
  }

  // Life & Health
  if (has("life insurance", "income protection", "health", "medical", "critical illness", "dental", "wellbeing", "nhs", "hospital")) {
    return "Life & Health";
  }

  // Trade (brokers/market/regulation/insurers)
  if (has("broker", "broking", "mga", "underwriting", "syndicate", "lloyd", "reinsurance", "claims", "fca", "pra", "abi", "biba", "sm&cr", "solvency", "regulator")) {
    return "Trade";
  }

  // Default to Business (macro, cyber, general)
  return defaultCategory || "Business";
}

// -----------------------------
// Feed discovery (for directory pages / sites without explicit feedUrl)
async function discoverFeedUrl(siteUrl) {
  const html = await fetchWithTimeout(siteUrl, 4500);
  const $ = cheerio.load(html);

  const candidates = [];

  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr("type") || "").toLowerCase();
    const href = $(el).attr("href");
    if (href && (type.includes("rss") || type.includes("atom") || type.includes("xml"))) candidates.push(href);
  });

  $("a").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;
    const h = href.toLowerCase();
    if (h.includes("rss") || h.includes("feed") || h.endsWith(".xml") || h.endsWith(".rss") || h.endsWith(".atom")) {
      candidates.push(href);
    }
  });

  const urls = candidates
    .map((href) => {
      try { return new URL(href, siteUrl).toString(); } catch { return null; }
    })
    .filter(Boolean);

  return urls[0] || null;
}

// -----------------------------
// Concurrency runner (limits simultaneous fetches)
async function mapWithConcurrency(items, limit, fn) {
  const results = [];
  let i = 0;

  async function worker() {
    while (i < items.length) {
      const idx = i++;
      results[idx] = await fn(items[idx], idx);
      await sleep(0);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// -----------------------------
// Main handler
export const handler = async () => {
  // Serve cache if warm + fresh
  const now = Date.now();
  if (CACHE.payload && (now - CACHE.ts) < CACHE_TTL_MS) {
    return {
      statusCode: 200,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "public, max-age=0, s-maxage=600"
      },
      body: JSON.stringify({ ...CACHE.payload, cached: true })
    };
  }

  const diagnostics = [];
  const sourceErrors = [];
  const allItems = [];

  const sources = sourcesCfg.sources || [];

  await mapWithConcurrency(sources, 6, async (source) => {
    const t0 = Date.now();
    try {
      let feedUrl = source.feedUrl;

      if (!feedUrl && source.siteUrl) {
        feedUrl = await discoverFeedUrl(source.siteUrl);
      }

      if (!feedUrl) throw new Error("No RSS/Atom feed found");

      // Fetch feed XML with timeout then parse
      const xml = await fetchWithTimeout(feedUrl, 4500);
      const feed = await parser.parseString(xml);

      const items = (feed.items || []).slice(0, 20);

      let kept = 0;
      for (const item of items) {
        const norm = normaliseItem(item, source.name);
        if (!norm.url || !norm.publishedAt) continue;

        norm.category = classifyCategory(source.defaultCategory, norm.title, norm.summary);
        allItems.push(norm);
        kept++;
      }

      diagnostics.push({
        source: source.name,
        ok: true,
        feedUrl,
        ms: Date.now() - t0,
        items: kept
      });
    } catch (err) {
      sourceErrors.push({ source: source.name, error: err.message });
      diagnostics.push({
        source: source.name,
        ok: false,
        ms: Date.now() - t0,
        error: err.message
      });
    }
  });

  const cleaned = dedupe(allItems).sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  const payload = {
    items: cleaned,
    sourceErrors,
    diagnostics,
    cached: false
  };

  CACHE = { ts: Date.now(), payload };

  return {
    statusCode: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=0, s-maxage=600"
    },
    body: JSON.stringify(payload)
  };
};
