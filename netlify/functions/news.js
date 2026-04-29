import Parser from 'rss-parser'
import * as cheerio from 'cheerio'
import sourcesCfg from '../../sources.json' assert { type: 'json' }

const parser = new Parser({
  timeout: 12000,
  headers: {
    'User-Agent': 'MarketInsightsDashboard/1.0 (+Netlify Function)'
  }
})

function normaliseItem(item, sourceName, categoryFallback) {
  const publishedAt = item.isoDate || item.pubDate || item.published || null
  return {
    id: item.guid || item.id || item.link || `${sourceName}:${item.title}`,
    title: (item.title || '').trim() || 'Untitled',
    url: item.link,
    source: sourceName,
    summary: ((item.contentSnippet || item.summary || item.content || '') + '').replace(/\s+/g,' ').trim().slice(0, 320),
    publishedAt,
    category: categoryFallback || 'Business'
  }
}

function dedupe(items) {
  const seen = new Set()
  return items.filter(i => {
    const key = `${i.url || ''}|${i.title || ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function pickCategory(sourceDefault, title, summary) {
  // Very simple keyword routing (optional). Source default wins.
  if (sourceDefault) return sourceDefault
  const text = `${title} ${summary}`.toLowerCase()
  const rules = [
    { cat: 'Motor', keys: ['motor','car','vehicle','fleet','adas','ev','collision','repair'] },
    { cat: 'Home', keys: ['home','property','buildings','contents','flood','subsidence'] },
    { cat: 'Life & Health', keys: ['life','health','protection','income protection','critical illness','medical'] },
    { cat: 'Rural', keys: ['rural','farm','agriculture','estate'] },
    { cat: 'Student', keys: ['student','university','campus'] },
    { cat: 'Trade', keys: ['broker','mga','underwriting','reinsurance','regulation','fca','pra','abi','biba'] },
  ]
  for (const r of rules) {
    if (r.keys.some(k => text.includes(k))) return r.cat
  }
  return 'Business'
}

async function discoverFeedUrl(siteUrl) {
  // Fetch the HTML and look for <link rel="alternate" type="application/rss+xml|application/atom+xml">
  // Also accept obvious feed hrefs.
  const res = await fetch(siteUrl, { redirect: 'follow' })
  if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
  const html = await res.text()
  const $ = cheerio.load(html)

  const candidates = []

  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase()
    const href = $(el).attr('href')
    if (!href) return
    if (type.includes('rss') || type.includes('atom') || type.includes('xml')) candidates.push(href)
  })

  $('a').each((_, el) => {
    const href = $(el).attr('href')
    if (!href) return
    const text = ($(el).text() || '').toLowerCase()
    const h = href.toLowerCase()
    if (h.includes('rss') || h.includes('atom') || h.endsWith('.xml') || text.includes('rss') || text.includes('feed')) {
      candidates.push(href)
    }
  })

  // Normalise and prefer likely feed links
  const norm = candidates
    .map(href => {
      try { return new URL(href, siteUrl).toString() } catch { return null }
    })
    .filter(Boolean)

  const preferred = norm.find(u => u.endsWith('/feed/') || u.includes('feed') || u.includes('rss') || u.includes('.atom') || u.endsWith('.xml'))
  return preferred || norm[0] || null
}

export default async (req) => {
  try {
    const sources = sourcesCfg.sources || []
    const results = []
    const sourceErrors = []

    // Pull from each source in parallel
    await Promise.all(sources.map(async (s) => {
      try {
        let feedUrl = s.feedUrl
        if (!feedUrl && s.siteUrl) {
          feedUrl = await discoverFeedUrl(s.siteUrl)
        }
        if (!feedUrl) throw new Error('No feed URL found')

        const feed = await parser.parseURL(feedUrl)
        const items = (feed.items || []).slice(0, 25)
        for (const item of items) {
          const tmp = normaliseItem(item, s.name, s.defaultCategory)
          tmp.category = pickCategory(s.defaultCategory, tmp.title, tmp.summary)
          // Only include usable items
          if (tmp.url && tmp.publishedAt) results.push(tmp)
        }
      } catch (e) {
        sourceErrors.push({ source: s.name, error: (e && e.message) ? e.message : String(e) })
      }
    }))

    const cleaned = dedupe(results)
      .sort((a,b) => new Date(b.publishedAt) - new Date(a.publishedAt))
      .slice(0, 400)

    return new Response(JSON.stringify({
      items: cleaned,
      // Expose sourceErrors for internal troubleshooting (safe because internal tool)
      sourceErrors
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        // Edge cache for 10 mins
        'Cache-Control': 'public, max-age=0, s-maxage=600'
      }
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Failed to fetch feeds' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    })
  }
}
