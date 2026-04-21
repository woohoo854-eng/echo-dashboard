# echo-dashboard

A kiosk-style dashboard replacing the old Echo Show spot on the ASUS display.
Shows time, Arvada weather (now + 8h hourly + 5-day), a stock/crypto ticker,
and rotating news headlines. Sky & peach pastel theme, light mode only.

## What's in v1
- Clock + date + hour-based greeting
- Weather for Arvada, CO (Open-Meteo, no API key)
- 8-hour hourly forecast strip
- 5-day outlook
- Tickers: S&P, NDX, DJI (Stooq), BTC, ETH (CoinGecko)
- News: AP, Reuters, BBC, NPR, Ars Technica, The Verge, HN — interleaved,
  one headline at a time with crossfade, rotates every 12s

All third-party calls are proxied server-side and cached so refreshes can't
hammer any API.

## Install (on Lenovo, at C:\Users\tod\echo-dashboard)

```powershell
cd C:\Users\tod\echo-dashboard
npm install
```

## Run standalone (quick test)

```powershell
node server.js
# then open http://192.168.1.3:3002
```

## Wire into dashboard-manager

Add a new entry in `C:\Users\tod\dashboard-manager\projects.json`:

```json
{
  "id": "echo-dashboard",
  "name": "Dashboard",
  "cwd": "C:\\Users\\tod\\echo-dashboard",
  "command": "node",
  "args": ["server.js"],
  "port": 3002,
  "env": { "PORT": "3002" }
}
```

(Match the field names your existing projects use. `flightboard` is the model.)

Start it from the dashboard-manager admin panel — it'll show up at
`http://192.168.1.3:3000/app/echo-dashboard/`.

## Endpoints
- `GET /`              — the kiosk page
- `GET /api/weather`   — JSON, 10 min cache
- `GET /api/tickers`   — JSON, 60 sec cache
- `GET /api/news`      — JSON, 10 min cache
- `GET /api/health`    — liveness probe

## Customizing
- **Location**: `LAT`, `LON`, `CITY` at the top of `server.js`
- **News feeds**: `FEEDS` array in `server.js`
- **Tickers**: `indexSymbols` (Stooq codes) + the CoinGecko call, both in `server.js`
- **Colors**: CSS variables at the top of `public/index.html`
- **News rotation speed**: `NEWS_INTERVAL` in `public/index.html`
