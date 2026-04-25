# Wallstreet Portfolio Manager (web)

Interactive portfolio form for the private `wallstreet-state` repo. Static HTML/JS, hosted on GitHub Pages.

## Live URL
`https://ohayiroglu.github.io/wallstreet-ui/`

## What it does
- Reads `positions.csv`, `transactions.csv`, `cash.json` from the private `wallstreet-state` repo via the authenticated GitHub API
- Cash deposits, BUY, SELL, CSV import — all commit atomically (Tree API) to the same repo
- Ticker search uses `ticker_index.json` (1636 SP500 + SP600 + SP400 + China + ADR tickers)

## Auth
Needs a Classic Personal Access Token with `repo` scope, no expiration (set-and-forget).
Generate at https://github.com/settings/tokens/new — token is stored in browser localStorage only,
never sent anywhere except api.github.com.

## Files
- `index.html` — UI structure
- `style.css` — dark theme matching weekly email
- `app.js` — state, search, GitHub Tree-API commits, CSV parsing
- `ticker_index.json` — `[{t, n, s}]` for autocomplete (regenerate from `qvalue/data/universe.json` in the main project if it changes)
