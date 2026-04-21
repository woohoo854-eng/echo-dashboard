// echo-dashboard server
// Node 18+ (uses global fetch). Tested against Node v24 on Windows.

const express = require('express');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

// ---------- Arvada, CO coordinates ----------
const LAT = 39.8028;
const LON = -105.0875;
const CITY = 'Arvada';

// ---------- Simple in-memory cache ----------
const cache = new Map();
async function cached(key, ttlMs, fetcher) {
  const now = Date.now();
  const hit = cache.get(key);
  if (hit && now - hit.ts < ttlMs) return hit.value;
  try {
    const value = await fetcher();
    cache.set(key, { ts: now, value });
    return value;
  } catch (err) {
    console.error(`[cache:${key}] fetch failed:`, err.message);
    // Serve stale if we have it; otherwise bubble up
    if (hit) return hit.value;
    throw err;
  }
}

// ---------- Weather (Open-Meteo, no key) ----------
app.get('/api/weather', async (_req, res) => {
  try {
    const data = await cached('weather', 10 * 60 * 1000, async () => {
      const url = new URL('https://api.open-meteo.com/v1/forecast');
      url.searchParams.set('latitude', LAT);
      url.searchParams.set('longitude', LON);
      url.searchParams.set('current', 'temperature_2m,weather_code,wind_speed_10m,relative_humidity_2m');
      url.searchParams.set('hourly', 'temperature_2m,weather_code');
      url.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min,weather_code');
      url.searchParams.set('temperature_unit', 'fahrenheit');
      url.searchParams.set('wind_speed_unit', 'mph');
      url.searchParams.set('timezone', 'America/Denver');
      url.searchParams.set('forecast_days', '6');

      const r = await fetch(url);
      if (!r.ok) throw new Error(`open-meteo ${r.status}`);
      const j = await r.json();

      // Build 8-hour forward hourly slice starting at current hour.
      // Open-Meteo returns hourly times in Denver local time ("2026-04-21T08:00"),
      // so we must compare against Denver local time, not UTC.
      const nowIso = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Denver',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', hour12: false,
      }).format(new Date()).replace(', ', 'T').slice(0, 13); // "YYYY-MM-DDTHH"
      const times = j.hourly?.time || [];
      let startIdx = times.findIndex(t => t.slice(0, 13) >= nowIso);
      if (startIdx < 0) startIdx = 0;
      const hourly = [];
      for (let i = 0; i < 8 && startIdx + i < times.length; i++) {
        const idx = startIdx + i;
        hourly.push({
          time: times[idx],
          temp: Math.round(j.hourly.temperature_2m[idx]),
          code: j.hourly.weather_code[idx],
        });
      }

      // 5 days starting tomorrow (skip today)
      const daily = [];
      const dailyTimes = j.daily?.time || [];
      for (let i = 1; i < Math.min(6, dailyTimes.length); i++) {
        daily.push({
          date: dailyTimes[i],
          high: Math.round(j.daily.temperature_2m_max[i]),
          low: Math.round(j.daily.temperature_2m_min[i]),
          code: j.daily.weather_code[i],
        });
      }

      return {
        city: CITY,
        current: {
          // Use the first hourly slot so this always matches the "NOW" cell in the hourly strip
          temp: hourly.length > 0 ? hourly[0].temp : Math.round(j.current.temperature_2m),
          code: j.current.weather_code,
          wind: Math.round(j.current.wind_speed_10m),
          humidity: Math.round(j.current.relative_humidity_2m),
        },
        today: {
          high: Math.round(j.daily.temperature_2m_max[0]),
          low: Math.round(j.daily.temperature_2m_min[0]),
        },
        hourly,
        daily,
        updated: Date.now(),
      };
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'weather_unavailable', message: err.message });
  }
});

// ---------- Tickers ----------
// Indices via Stooq CSV (no key). Crypto via CoinGecko public API.
async function fetchStooq(symbol) {
  // e.g. ^spx, ^ndx, ^dji for US indices on Stooq
  const r = await fetch(`https://stooq.com/q/l/?s=${encodeURIComponent(symbol)}&f=sd2t2ohlcv&h&e=csv`);
  if (!r.ok) throw new Error(`stooq ${symbol} ${r.status}`);
  const text = await r.text();
  const lines = text.trim().split('\n');
  if (lines.length < 2) throw new Error(`stooq ${symbol} empty`);
  const [header, row] = lines;
  const cols = header.split(',');
  const vals = row.split(',');
  const o = Object.fromEntries(cols.map((c, i) => [c.trim(), vals[i]?.trim()]));
  const close = parseFloat(o.Close);
  const open = parseFloat(o.Open);
  if (!isFinite(close) || !isFinite(open) || open === 0) throw new Error(`stooq ${symbol} NaN`);
  const changePct = ((close - open) / open) * 100;
  return { price: close, changePct };
}

async function fetchCrypto() {
  const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum&vs_currencies=usd&include_24hr_change=true');
  if (!r.ok) throw new Error(`coingecko ${r.status}`);
  return r.json();
}

app.get('/api/tickers', async (_req, res) => {
  try {
    const data = await cached('tickers', 60 * 1000, async () => {
      const items = [];

      // Indices — fetch each independently so one failure doesn't nuke the row
      const indexSymbols = [
        { label: 'S&P',   stooq: '^spx', format: 'index' },
        { label: 'NDX',   stooq: '^ndx', format: 'index' },
        { label: 'DJI',   stooq: '^dji', format: 'index' },
      ];
      for (const s of indexSymbols) {
        try {
          const q = await fetchStooq(s.stooq);
          items.push({ label: s.label, price: q.price, changePct: q.changePct, format: s.format });
        } catch (e) {
          console.warn(`[tickers] ${s.label} failed: ${e.message}`);
          items.push({ label: s.label, error: true });
        }
      }

      try {
        const c = await fetchCrypto();
        if (c.bitcoin)  items.push({ label: 'BTC', price: c.bitcoin.usd,  changePct: c.bitcoin.usd_24h_change,  format: 'crypto' });
        if (c.ethereum) items.push({ label: 'ETH', price: c.ethereum.usd, changePct: c.ethereum.usd_24h_change, format: 'crypto' });
      } catch (e) {
        console.warn(`[tickers] crypto failed: ${e.message}`);
        items.push({ label: 'BTC', error: true });
        items.push({ label: 'ETH', error: true });
      }

      return { items, updated: Date.now() };
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'tickers_unavailable', message: err.message });
  }
});

// ---------- News (RSS, no key) ----------
// Minimal RSS/Atom parser — enough for headline + source
function parseFeed(xml, sourceName) {
  const items = [];
  // RSS 2.0
  const itemRegex = /<item[\s\S]*?<\/item>/g;
  const titleRegex = /<title(?:\s[^>]*)?>([\s\S]*?)<\/title>/;
  const linkRegex = /<link(?:\s[^>]*)?>([\s\S]*?)<\/link>/;
  const pubRegex = /<pubDate(?:\s[^>]*)?>([\s\S]*?)<\/pubDate>/;

  let m;
  while ((m = itemRegex.exec(xml)) !== null) {
    const chunk = m[0];
    const t = titleRegex.exec(chunk);
    const l = linkRegex.exec(chunk);
    const p = pubRegex.exec(chunk);
    if (t) {
      items.push({
        title: decodeXmlEntities(stripCdata(t[1]).trim()),
        link: l ? stripCdata(l[1]).trim() : null,
        published: p ? new Date(stripCdata(p[1]).trim()).getTime() : Date.now(),
        source: sourceName,
      });
    }
  }

  // Atom fallback
  if (items.length === 0) {
    const entryRegex = /<entry[\s\S]*?<\/entry>/g;
    while ((m = entryRegex.exec(xml)) !== null) {
      const chunk = m[0];
      const t = titleRegex.exec(chunk);
      const pubA = /<(?:updated|published)(?:\s[^>]*)?>([\s\S]*?)<\/(?:updated|published)>/.exec(chunk);
      if (t) {
        items.push({
          title: decodeXmlEntities(stripCdata(t[1]).trim()),
          link: null,
          published: pubA ? new Date(stripCdata(pubA[1]).trim()).getTime() : Date.now(),
          source: sourceName,
        });
      }
    }
  }
  return items;
}

function stripCdata(s) {
  return s.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
}
function decodeXmlEntities(s) {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)));
}

const FEEDS = [
  { name: 'AP',            url: 'https://feeds.apnews.com/apnews/topnews',                    kind: 'general' },
  { name: 'Reuters World', url: 'https://feeds.reuters.com/Reuters/worldNews',                kind: 'general' },
  { name: 'BBC',           url: 'https://feeds.bbci.co.uk/news/world/rss.xml',                kind: 'general' },
  { name: 'NPR',           url: 'https://feeds.npr.org/1001/rss.xml',                         kind: 'general' },
  { name: 'Ars Technica',  url: 'https://feeds.arstechnica.com/arstechnica/index',            kind: 'tech' },
  { name: 'The Verge',     url: 'https://www.theverge.com/rss/index.xml',                     kind: 'tech' },
  { name: 'Hacker News',   url: 'https://hnrss.org/frontpage',                                kind: 'tech' },
];

app.get('/api/news', async (_req, res) => {
  try {
    const data = await cached('news', 10 * 60 * 1000, async () => {
      const results = await Promise.allSettled(
        FEEDS.map(async f => {
          const r = await fetch(f.url, { headers: { 'User-Agent': 'echo-dashboard/1.0' } });
          if (!r.ok) throw new Error(`${f.name} ${r.status}`);
          const xml = await r.text();
          return parseFeed(xml, f.name).slice(0, 6); // top 6 per feed
        })
      );
      const all = results
        .filter(r => r.status === 'fulfilled')
        .flatMap(r => r.value)
        .filter(item => item.title && item.title.length > 10);

      // De-dupe by normalized title
      const seen = new Set();
      const deduped = [];
      for (const item of all) {
        const key = item.title.toLowerCase().replace(/\s+/g, ' ').slice(0, 80);
        if (seen.has(key)) continue;
        seen.add(key);
        deduped.push(item);
      }

      // Interleave so you don't see 6 Verge headlines in a row
      deduped.sort((a, b) => (b.published || 0) - (a.published || 0));
      const bySource = new Map();
      for (const it of deduped) {
        if (!bySource.has(it.source)) bySource.set(it.source, []);
        bySource.get(it.source).push(it);
      }
      const interleaved = [];
      let remaining = true;
      while (remaining) {
        remaining = false;
        for (const arr of bySource.values()) {
          if (arr.length) { interleaved.push(arr.shift()); remaining = true; }
        }
      }

      return { items: interleaved.slice(0, 40), updated: Date.now() };
    });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: 'news_unavailable', message: err.message });
  }
});

// ---------- Health ----------
app.get('/api/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// ---------- Static ----------
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, '0.0.0.0', () => {
  console.log(`[echo-dashboard] listening on port ${PORT}`);
});

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[echo-dashboard] port ${PORT} in use (TIME_WAIT), retrying in 3s...`);
    setTimeout(() => server.listen(PORT, '0.0.0.0'), 3000);
  } else {
    console.error('[echo-dashboard] server error:', err);
    process.exit(1);
  }
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
