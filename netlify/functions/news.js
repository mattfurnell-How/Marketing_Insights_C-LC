import Parser from 'rss-parser'
import * as cheerio from 'cheerio'
import sourcesCfg from './sources.json' assert { type: 'json' }

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'MarketInsightsDashboard/1.0 (+Netlify Function)'
  }
})

function normaliseItem(item, sourceName, categoryFallback) {
  const publishedAt = item.isoDate || item.pubDate || item.published || null

  return {
    id: item.guid || item.id || item.link || `${sourceName}-${item.title}`,
    title: (item.title || '').trim(),
    url: item.link,
    source: sourceName,
    summary: ((item.contentSnippet || item.summary || item.content || '') + '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300),
    publishedAt,
    category: categoryFallback || 'Business'
  }
}

function dedupe(items) {
  const seen = new Set()
  return items.filter(item => {
    const key = `${item.url}|${item.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function autoCategory(defaultCategory, title, summary) {
  if (defaultCategory) return defaultCategory

  const text = `${title} ${summary}`.toLowerCase()

  const rules = [
    { cat: 'Motor', keys: ['motor', 'vehicle', 'car', 'ev', 'fleet'] },
    { cat: 'Home', keys: ['home', 'property', 'buildings', 'flood'] },
    { cat: 'Life & Health', keys: ['life', 'health', 'protection', 'medical'] },
    { cat: 'Rural', keys: ['rural', 'farm', 'agriculture'] },
    { cat: 'Student', keys: ['student', 'university'] },
    { cat: 'Trade', keys: ['broker', 'mga', 'underwriting', 'fca', 'biba', 'abi'] }
  ]

  for (const rule of rules) {
    if (rule.keys.some(k => text.includes(k))) {
      return rule.cat
    }
  }

  return 'Business'
}

async function discoverFeedUrl(siteUrl) {
  const res = await fetch(siteUrl, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Failed to fetch ${siteUrl}`)

  const html = await res.text()
  const $ = cheerio.load(html)

  const candidates = []

  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase()
    const href = $(el).attr('href')
    if (href && (type.includes('rss') || type.includes('atom') || type.includes('xml'))) {
      candidates.push(href)
    }
  })

  $('a').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return

    const h = href.toLowerCase()
    if (h.includes('rss') || h.includes('feed') || h.endsWith('.xml')) {
      candidates.push(href)
    }
  })

  const urls = candidates
    .map(href => {
      try {
        return new URL(href, siteUrl).toString()
      } catch {
        return null
      }
    })
    .filter(Boolean)

  return urls[0] || null
}

/**
 * ✅ NETLIFY FUNCTION ENTRY POINT
 */
export const handler = async () => {
  try {
    const results = []
    const sourceErrors = []

    for (const source of sourcesCfg.sources) {
      try {
        let feedUrl = source.feedUrl

        if (!feedUrl && source.siteUrl) {
          feedUrl = await discoverFeedUrl(source.siteUrl)
        }

        if (!feedUrl) {
          throw new Error('No RSS/Atom feed found')
        }

        const feed = await parser.parseURL(feedUrl)
        const items = feed.items || []

        for (const item of items.slice(0, 25)) {
          const normalised = normaliseItem(
            item,
            source.name,
            source.defaultCategory
          )

          if (!normalised.url || !normalised.publishedAt) continue

          normalised.category = autoCategory(
            source.defaultCategory,
            normalised.title,
            normalised.summary
          )

          results.push(normalised)
        }
      } catch (err) {
        sourceErrors.push({
          source: source.name,
          error: err.message
        })
      }
    }

    const cleaned = dedupe(results).sort(
      (a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)
    )

    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=0, s-maxage=600'
      },
      body: JSON.stringify({
        items: cleaned,
        sourceErrors
      })
    }
  } catch (err) {
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Function crashed',
        message: err.message
      })
    }
  }
}
