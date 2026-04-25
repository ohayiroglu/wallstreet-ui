# Wallstreet Portfolio Manager (web)

Interactive portfolio form for `wallstreet-state`. Static HTML/JS, hosted on GitHub Pages.

## Live URL
After enabling GitHub Pages on this repo (Settings → Pages → Source: `main` branch, folder: `/docs`):

`https://ohayiroglu.github.io/wallstreet-state/`

## What it does
- Reads `positions.csv`, `transactions.csv`, `cash.json` from the repo (raw fetch, no auth)
- Cash deposits, buy/sell entry, CSV import — all commit directly to the repo via the GitHub API
- Ticker search uses `ticker_index.json` (1636 SP500 + SP600 + SP400 + China + ADR tickers)

## Auth
Needs a fine-grained Personal Access Token with **Contents: Read and write** scope on this single repo.
Token is stored in browser localStorage only — never sent anywhere except api.github.com.

## Files
- `index.html` — UI structure
- `style.css` — dark theme matching weekly email
- `app.js` — state, search, GitHub API commits, CSV parsing
- `ticker_index.json` — `[{t, n, s}]` for autocomplete (regenerate with the Python snippet in main project if universe.json changes)
