// Investment Portfolio — static GitHub Pages app
// Reads/writes positions.csv, transactions.csv on github.com/ohayiroglu/wallstreet-state via the GitHub API.
// Single-strategy UI (GPM canonical 2026-04-29). The strategy column is still
// written to CSV (default "gpm") for backend compat but is invisible in the UI.

const REPO = "ohayiroglu/wallstreet-state";
const BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const API_BASE = `https://api.github.com/repos/${REPO}`;

// In-memory state. Cash management was removed from the UI on 2026-04-29:
// GPM auto-sizes the buy amount and the user manages USD directly in T212,
// so an "Add Cash" form was just noise. We still load cash.json (DCF strategy
// needs it), but Buy/Sell no longer mutate it from the UI.
const state = {
  cash: { cash: 0, total_contributed: 0, last_contribution_date: null },
  positions: [],   // [{ticker, shares, cost_basis, first_buy_date, sector, strategy}]
  transactions: [], // [{date, action, ticker, shares, price, amount, strategy}]
  tickerIndex: [],  // [{t, n, s}]
  pendingCsvRows: null,
  livePrices: {},  // ticker → {price, prevClose, change, changePct, dayHigh, dayLow, w52High, w52Low, ts}
  pricesLoadedAt: null,
};

// ---------- Toast ----------
function toast(msg, kind = "") {
  let t = document.getElementById("toast");
  if (!t) {
    t = document.createElement("div");
    t.id = "toast";
    document.body.appendChild(t);
  }
  t.className = `show ${kind}`;
  t.textContent = msg;
  setTimeout(() => t.classList.remove("show"), 3500);
}

// ---------- Token ----------
function getToken() {
  return localStorage.getItem("ws_gh_pat") || "";
}
function saveToken(t) {
  localStorage.setItem("ws_gh_pat", t);
}
function clearToken() {
  localStorage.removeItem("ws_gh_pat");
}

function showTokenSetup(visible) {
  document.getElementById("token-setup").classList.toggle("hidden", !visible);
}

// ---------- Prices ----------
// Two-tier strategy:
//   1. Try Yahoo's CORS endpoint per ticker (works in some browsers/regions).
//   2. Fall back to prices.json snapshot committed daily by the GH Actions
//      "Daily Prices Snapshot" workflow.
async function fetchYahooQuote(ticker) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1d&range=2d`;
  const res = await fetch(url, { mode: "cors" });
  if (!res.ok) throw new Error(`yahoo ${ticker} ${res.status}`);
  const j = await res.json();
  const meta = j?.chart?.result?.[0]?.meta;
  if (!meta || !meta.regularMarketPrice) throw new Error(`no price ${ticker}`);
  const price = Number(meta.regularMarketPrice);
  const prev = Number(meta.previousClose ?? meta.chartPreviousClose ?? price);
  return {
    price,
    prevClose: prev,
    change: price - prev,
    changePct: prev > 0 ? (price / prev - 1) * 100 : 0,
    dayHigh: Number(meta.regularMarketDayHigh ?? price),
    dayLow:  Number(meta.regularMarketDayLow ?? price),
    w52High: Number(meta.fiftyTwoWeekHigh ?? 0),
    w52Low:  Number(meta.fiftyTwoWeekLow ?? 0),
    currency: meta.currency || "USD",
    source: "yahoo",
    ts: Date.now(),
  };
}

async function fetchPricesSnapshot() {
  // Read prices.json from the wallstreet-state repo (auth via PAT — repo is private)
  const txt = await ghFetchRaw("prices.json");
  if (!txt) return null;
  const j = JSON.parse(txt);
  return j;
}

function quoteFromSnapshot(snapshot, ticker) {
  const t = snapshot?.tickers?.[ticker];
  if (!t || !t.price) return null;
  return {
    price: t.price,
    prevClose: t.prev_close,
    change: t.change,
    changePct: t.change_pct,
    dayHigh: t.day_high,
    dayLow:  t.day_low,
    w52High: t.w52_high || 0,
    w52Low:  t.w52_low  || 0,
    currency: t.currency || "USD",
    source: "snapshot",
    ts: snapshot.computed_at,
  };
}

async function refreshLivePrices() {
  const tickers = [...new Set(state.positions.map(p => p.ticker))];
  if (tickers.length === 0) return;
  const status = document.getElementById("prices-status");
  status.textContent = `Fetching ${tickers.length} prices...`;

  let ok = 0, yahooFail = 0;
  await Promise.all(tickers.map(async t => {
    try {
      state.livePrices[t] = await fetchYahooQuote(t);
      ok++;
    } catch (e) {
      yahooFail++;
    }
  }));

  // Fill any gap from the daily snapshot
  let snapshotInfo = null;
  if (yahooFail > 0) {
    try {
      const snap = await fetchPricesSnapshot();
      if (snap) {
        snapshotInfo = snap;
        for (const t of tickers) {
          if (!state.livePrices[t]) {
            const q = quoteFromSnapshot(snap, t);
            if (q) { state.livePrices[t] = q; ok++; }
          }
        }
      }
    } catch (e) {
      console.error("snapshot fetch:", e);
    }
  }

  state.pricesLoadedAt = Date.now();
  const haveLive = Object.values(state.livePrices).some(q => q.source === "yahoo");
  const haveSnap = Object.values(state.livePrices).some(q => q.source === "snapshot");
  const when = new Date().toLocaleTimeString();
  let label = `${ok}/${tickers.length} loaded ${when}`;
  if (haveLive && haveSnap) label += " — mixed (Yahoo + snapshot)";
  else if (haveLive) label += " — live (Yahoo)";
  else if (haveSnap && snapshotInfo) {
    label = `${ok}/${tickers.length} from daily snapshot — asof ${snapshotInfo.asof}`;
  } else if (ok === 0) label = `Could not load prices (Yahoo CORS blocked, snapshot empty)`;
  status.textContent = label;
  renderPortfolio();
}

// ---------- Strategy helpers ----------
// Single-strategy UI (GPM). Backend CSV still uses the strategy column
// (default "gpm") so legacy/historic entries keep their tag.
function normalizeStrategy(s) {
  const v = (s || "").toString().trim().toLowerCase();
  return v || "gpm";
}

// ---------- GitHub API ----------
async function ghFetchRaw(path) {
  const token = getToken();
  const headers = { Accept: "application/vnd.github.raw" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${API_BASE}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return res.text();
}

async function ghCommitMultiFile(filesMap, message) {
  const token = getToken();
  if (!token) throw new Error("no token");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

  const refRes = await fetch(`${API_BASE}/git/refs/heads/${BRANCH}`, { headers });
  if (!refRes.ok) throw new Error(`ref fetch: ${refRes.status} ${await refRes.text()}`);
  const refJ = await refRes.json();
  const parentSha = refJ.object.sha;

  const commitRes = await fetch(`${API_BASE}/git/commits/${parentSha}`, { headers });
  if (!commitRes.ok) throw new Error(`commit fetch: ${commitRes.status}`);
  const commitJ = await commitRes.json();
  const baseTree = commitJ.tree.sha;

  const treeEntries = [];
  for (const [path, content] of Object.entries(filesMap)) {
    const blobRes = await fetch(`${API_BASE}/git/blobs`, {
      method: "POST",
      headers,
      body: JSON.stringify({ content, encoding: "utf-8" }),
    });
    if (!blobRes.ok) throw new Error(`blob ${path}: ${blobRes.status} ${await blobRes.text()}`);
    const blobJ = await blobRes.json();
    treeEntries.push({ path, mode: "100644", type: "blob", sha: blobJ.sha });
  }

  const treeRes = await fetch(`${API_BASE}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  if (!treeRes.ok) throw new Error(`tree: ${treeRes.status} ${await treeRes.text()}`);
  const treeJ = await treeRes.json();

  const newCommitRes = await fetch(`${API_BASE}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, tree: treeJ.sha, parents: [parentSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`commit create: ${newCommitRes.status} ${await newCommitRes.text()}`);
  const newCommitJ = await newCommitRes.json();

  const updateRes = await fetch(`${API_BASE}/git/refs/heads/${BRANCH}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ sha: newCommitJ.sha, force: false }),
  });
  if (!updateRes.ok) throw new Error(`ref update: ${updateRes.status} ${await updateRes.text()}`);
  return newCommitJ.sha;
}

// ---------- CSV utilities ----------
// Robust parser: handles UTF-8 BOM, quoted fields, embedded commas, and
// the "" escape-quote sequence. Trade Republic + Parqet exports use this
// dialect (e.g. description fields contain commas inside quotes).
function csvParse(text) {
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);  // strip BOM
  const lines = text.split(/\r?\n/).filter(l => l.length > 0);
  if (lines.length === 0) return { headers: [], rows: [] };

  const parseLine = (line) => {
    const cells = [];
    let cur = "";
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (inQuote) {
        if (c === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; }   // "" escape
          else inQuote = false;
        } else cur += c;
      } else {
        if (c === '"') inQuote = true;
        else if (c === ",") { cells.push(cur); cur = ""; }
        else cur += c;
      }
    }
    cells.push(cur);
    return cells.map(c => c.trim());
  };

  const headers = parseLine(lines[0]);
  const rows = lines.slice(1).map(line => {
    const cols = parseLine(line);
    const obj = {};
    headers.forEach((h, i) => obj[h] = cols[i] || "");
    return obj;
  });
  return { headers, rows };
}

function csvStringify(rows, headers) {
  const out = [headers.join(",")];
  for (const r of rows) {
    out.push(headers.map(h => r[h] !== undefined && r[h] !== null ? String(r[h]) : "").join(","));
  }
  return out.join("\n") + "\n";
}

// ---------- State load ----------
async function loadState() {
  document.getElementById("status").textContent = "Loading from GitHub...";
  try {
    const [posTxt, txnTxt, cashTxt] = await Promise.all([
      ghFetchRaw("positions.csv"),
      ghFetchRaw("transactions.csv"),
      ghFetchRaw("cash.json"),
    ]);

    state.positions = posTxt ? parsePositions(posTxt) : [];
    state.transactions = txnTxt ? parseTransactions(txnTxt) : [];
    state.cash = cashTxt ? JSON.parse(cashTxt) : { cash: 0, total_contributed: 0, last_contribution_date: null };

    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    document.getElementById("last-sync").textContent = "Synced: " + new Date().toLocaleTimeString();
    document.getElementById("status").textContent =
      `${state.positions.length} positions • ${state.transactions.length} transactions`;

    // Live prices in the background — surface MTM as soon as Yahoo responds
    refreshLivePrices().catch(err => console.error("price refresh:", err));
  } catch (e) {
    console.error("loadState failed:", e);
    toast("Load error: " + (e.message || e), "bad");
    document.getElementById("status").textContent = "ERROR — " + (e.message || "see console");
  }
}

function parsePositions(text) {
  const { rows } = csvParse(text);
  return rows.map(r => ({
    ticker: r.ticker,
    shares: parseFloat(r.shares) || 0,
    cost_basis: parseFloat(r.cost_basis) || 0,
    first_buy_date: r.first_buy_date || "",
    sector: r.sector || "",
    strategy: normalizeStrategy(r.strategy),
  }));
}

function parseTransactions(text) {
  const { rows } = csvParse(text);
  return rows.map(r => ({
    date: r.date,
    action: r.action,
    ticker: r.ticker,
    shares: parseFloat(r.shares) || 0,
    price: parseFloat(r.price) || 0,
    amount: parseFloat(r.amount) || 0,
    // DEPOSIT rows have no strategy (cash pool is shared); keep blank for those
    strategy: r.action === "DEPOSIT" ? "" : normalizeStrategy(r.strategy),
  }));
}

function serializePositions(positions) {
  return csvStringify(
    positions.map(p => ({
      ticker: p.ticker,
      shares: p.shares.toFixed(6).replace(/\.?0+$/, ""),
      cost_basis: p.cost_basis.toFixed(2),
      first_buy_date: p.first_buy_date,
      sector: p.sector,
      strategy: p.strategy || "gpm",
    })),
    ["ticker", "shares", "cost_basis", "first_buy_date", "sector", "strategy"]
  );
}

function serializeTransactions(txns) {
  return csvStringify(
    txns.map(t => ({
      date: t.date,
      action: t.action,
      ticker: t.ticker || "",
      shares: t.shares ? t.shares.toFixed(6).replace(/\.?0+$/, "") : "0",
      price: t.price ? t.price.toFixed(4).replace(/\.?0+$/, "") : "0",
      amount: (t.amount || 0).toFixed(2),
      strategy: t.action === "DEPOSIT" ? "" : (t.strategy || "gpm"),
    })),
    ["date", "action", "ticker", "shares", "price", "amount", "strategy"]
  );
}

// ---------- Render ----------
function fmtMoney(v) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
}

function fmtNum(v, dp = 2) {
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}
function fmtSigned(v) {
  const s = v >= 0 ? "+" : "";
  return s + fmtNum(v);
}

function renderPortfolio() {
  const tbody = document.querySelector("#positions-table tbody");
  const emptyEl = document.getElementById("empty-positions");
  const tableEl = document.getElementById("positions-table");
  tbody.innerHTML = "";
  const sorted = [...state.positions].sort((a, b) => b.cost_basis - a.cost_basis);

  let totalCost = 0, totalValue = 0;

  for (const p of sorted) {
    const live = state.livePrices[p.ticker];
    const avgCost = p.shares > 0 ? p.cost_basis / p.shares : 0;
    const value = live ? p.shares * live.price : null;
    const pl = value !== null ? value - p.cost_basis : null;
    const plPct = (pl !== null && p.cost_basis > 0) ? (pl / p.cost_basis) * 100 : null;

    totalCost += p.cost_basis;
    if (value !== null) totalValue += value;

    // 52w range bar — marker at current price relative to [low, high]
    let rangeCell = `<span class="muted">—</span>`;
    if (live && live.w52High > live.w52Low && live.w52Low > 0) {
      const lo = live.w52Low, hi = live.w52High, px = live.price;
      const pct = Math.max(0, Math.min(100, ((px - lo) / (hi - lo)) * 100));
      rangeCell = `
        <span class="muted" style="font-size:11px;">$${fmtNum(lo)}</span>
        <span class="range-bar"><span class="marker" style="left:${pct.toFixed(0)}%"></span></span>
        <span class="muted" style="font-size:11px;">$${fmtNum(hi)}</span>`;
    }

    // Day delta cell
    let dayCell = `<span class="muted">—</span>`;
    if (live) {
      const cls = live.changePct > 0 ? "day-delta-pos" : live.changePct < 0 ? "day-delta-neg" : "";
      dayCell = `<span class="${cls}">${live.changePct >= 0 ? "+" : ""}${fmtNum(live.changePct)}%</span>`;
    }

    // P&L cell
    let plCell = `<span class="muted">—</span>`;
    if (pl !== null) {
      const cls = pl > 0 ? "pl-pos" : pl < 0 ? "pl-neg" : "pl-zero";
      const pctTxt = plPct !== null ? `(${plPct >= 0 ? "+" : ""}${fmtNum(plPct, 1)}%)` : "";
      plCell = `<span class="${cls}">${pl >= 0 ? "+" : ""}$${fmtNum(Math.abs(pl), 0)} <small>${pctTxt}</small></span>`;
    }

    const row = document.createElement("tr");
    row.dataset.ticker = p.ticker;
    row.innerHTML = `
      <td><strong>${p.ticker}</strong>
        <div class="muted" style="font-size:11px;">${p.first_buy_date}</div></td>
      <td class="muted" style="font-size:12px;">${p.sector || ""}</td>
      <td class="num">${p.shares.toFixed(4).replace(/\.?0+$/, "")}</td>
      <td class="num">$${fmtNum(avgCost)}</td>
      <td class="num">${live ? "$" + fmtNum(live.price) : "<span class='muted'>—</span>"}</td>
      <td class="num">${dayCell}</td>
      <td class="num">${rangeCell}</td>
      <td class="num">${value !== null ? "$" + fmtNum(value, 0) : "<span class='muted'>—</span>"}</td>
      <td class="num">${plCell}</td>
      <td class="actions">
        <button class="row-action" data-act="edit-pos" data-ticker="${p.ticker}" title="Edit">✏️</button>
        <button class="row-action danger" data-act="del-pos" data-ticker="${p.ticker}" title="Delete">🗑️</button>
      </td>`;
    tbody.appendChild(row);
  }

  if (sorted.length === 0) {
    tableEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  } else {
    tableEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
  }

  const totalPL = totalValue - totalCost;
  const totalPLPct = totalCost > 0 ? (totalPL / totalCost) * 100 : 0;
  document.getElementById("total-cost").textContent = "$" + fmtNum(totalCost, 0);
  document.getElementById("total-value").textContent = totalValue > 0 ? "$" + fmtNum(totalValue, 0) : "—";
  const plEl = document.getElementById("total-pl");
  if (totalValue > 0) {
    const sign = totalPL >= 0 ? "+" : "";
    plEl.innerHTML = `<span class="${totalPL >= 0 ? "pl-pos" : "pl-neg"}">${sign}$${fmtNum(Math.abs(totalPL), 0)} (${sign}${fmtNum(totalPLPct, 1)}%)</span>`;
  } else {
    plEl.textContent = "—";
  }
}

function renderTransactions() {
  const tbody = document.querySelector("#transactions-table tbody");
  tbody.innerHTML = "";
  // Use full list — index in state.transactions is the stable identifier
  const indexed = state.transactions
    .map((t, i) => ({ ...t, _idx: i }))
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 20);
  for (const t of indexed) {
    const row = document.createElement("tr");
    row.dataset.idx = t._idx;
    const actionColor = t.action === "BUY" ? "#10B981" : t.action === "SELL" ? "#EF4444" : "#94A3B8";
    row.innerHTML = `
      <td>${t.date}</td>
      <td style="color:${actionColor}">${t.action}</td>
      <td>${t.ticker || ""}</td>
      <td class="num">${t.shares ? t.shares.toFixed(4).replace(/\.?0+$/, "") : ""}</td>
      <td class="num">${t.price ? "$" + fmtNum(t.price) : ""}</td>
      <td class="num">$${fmtNum(t.amount, 0)}</td>
      <td class="actions">
        <button class="row-action" data-act="edit-txn" data-idx="${t._idx}" title="Edit">✏️</button>
        <button class="row-action danger" data-act="del-txn" data-idx="${t._idx}" title="Delete">🗑️</button>
      </td>`;
    tbody.appendChild(row);
  }
}

function refreshSellDropdown() {
  const sel = document.getElementById("sell-ticker");
  sel.innerHTML = '<option value="">— select —</option>';
  for (const p of state.positions) {
    const opt = document.createElement("option");
    const key = `${p.ticker}|${p.strategy}`;
    opt.value = key;
    opt.textContent = `${p.ticker} (${p.shares.toFixed(4).replace(/\.?0+$/, "")} shares)`;
    sel.appendChild(opt);
  }
}

// ---------- Ticker search ----------
async function loadTickerIndex() {
  const res = await fetch("ticker_index.json");
  state.tickerIndex = await res.json();
}

function searchTickers(q) {
  if (!q) return [];
  const ql = q.toLowerCase();
  const exact = [], tickerPrefix = [], namePrefix = [], substring = [];
  for (const t of state.tickerIndex) {
    const tl = t.t.toLowerCase();
    const nl = t.n.toLowerCase();
    if (tl === ql) exact.push(t);
    else if (tl.startsWith(ql)) tickerPrefix.push(t);
    else if (nl.startsWith(ql)) namePrefix.push(t);
    else if (tl.includes(ql) || nl.includes(ql)) substring.push(t);
    if (exact.length + tickerPrefix.length + namePrefix.length + substring.length > 50) break;
  }
  return [...exact, ...tickerPrefix, ...namePrefix, ...substring].slice(0, 10);
}

function setupTickerSearch() {
  const input = document.getElementById("buy-ticker");
  const dropdown = document.getElementById("ticker-results");
  input.addEventListener("input", () => {
    const q = input.value.trim();
    if (q.length < 1) {
      dropdown.classList.add("hidden");
      return;
    }
    const results = searchTickers(q);
    dropdown.innerHTML = "";
    if (results.length === 0) {
      dropdown.innerHTML = '<div class="dropdown-item muted">No match</div>';
    } else {
      for (const r of results) {
        const item = document.createElement("div");
        item.className = "dropdown-item";
        item.innerHTML = `<span class="ticker">${r.t}</span><span class="name">${r.n}</span>`;
        item.addEventListener("click", () => {
          input.value = r.t;
          input.dataset.selectedTicker = r.t;
          input.dataset.selectedName = r.n;
          input.dataset.selectedSector = r.s;
          dropdown.classList.add("hidden");
          updateBuySummary();
        });
        dropdown.appendChild(item);
      }
    }
    dropdown.classList.remove("hidden");
  });
  document.addEventListener("click", (e) => {
    if (!input.contains(e.target) && !dropdown.contains(e.target)) {
      dropdown.classList.add("hidden");
    }
  });
}

function updateBuySummary() {
  const t = document.getElementById("buy-ticker").dataset.selectedTicker || document.getElementById("buy-ticker").value.trim();
  const s = parseFloat(document.getElementById("buy-shares").value) || 0;
  const p = parseFloat(document.getElementById("buy-price").value) || 0;
  const sum = document.getElementById("buy-summary");
  if (t && s && p) {
    const total = s * p;
    sum.textContent = `Total: ${fmtMoney(total)}`;
  } else {
    sum.textContent = "";
  }
}

function updateSellSummary() {
  const key = document.getElementById("sell-ticker").value;
  const s = parseFloat(document.getElementById("sell-shares").value) || 0;
  const p = parseFloat(document.getElementById("sell-price").value) || 0;
  const sum = document.getElementById("sell-summary");
  if (key && s && p) {
    const [tk] = key.split("|");
    const total = s * p;
    const pos = state.positions.find(x => x.ticker === tk);
    const remaining = pos ? (pos.shares - s).toFixed(4) : "?";
    sum.textContent = `Proceeds: ${fmtMoney(total)} • Remaining: ${remaining} ${tk}`;
  } else {
    sum.textContent = "";
  }
}

// ---------- Tabs ----------
function setupTabs() {
  document.querySelectorAll(".tab-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const tab = btn.dataset.tab;
      document.querySelectorAll(".tab-btn").forEach(b => b.classList.toggle("active", b === btn));
      document.querySelectorAll(".tab-content").forEach(c => c.classList.toggle("active", c.dataset.tab === tab));
    });
  });
}

// ---------- Actions ----------
function todayIso() {
  const d = new Date();
  return d.toISOString().slice(0, 10);
}

async function submitBuy() {
  const tk = (document.getElementById("buy-ticker").value || "").trim().toUpperCase();
  const shares = parseFloat(document.getElementById("buy-shares").value);
  const price = parseFloat(document.getElementById("buy-price").value);
  const date = document.getElementById("buy-date").value || todayIso();
  const strategy = buyStrategySelected();
  if (!tk || !shares || !price) { toast("Fill all fields", "bad"); return; }
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }
  const amount = shares * price;

  // Each (ticker, strategy) pair is its own position so DCF and GPM stay separate
  const newPositions = [...state.positions];
  const existing = newPositions.find(p => p.ticker === tk && p.strategy === strategy);
  const sector = document.getElementById("buy-ticker").dataset.selectedSector
                 || (state.tickerIndex.find(x => x.t === tk) || {}).s
                 || (existing ? existing.sector : "Other");
  if (existing) {
    existing.shares = (existing.shares || 0) + shares;
    existing.cost_basis = (existing.cost_basis || 0) + amount;
    if (!existing.first_buy_date) existing.first_buy_date = date;
  } else {
    newPositions.push({
      ticker: tk, shares, cost_basis: amount,
      first_buy_date: date, sector, strategy,
    });
  }

  const newTxns = [...state.transactions, {
    date, action: "BUY", ticker: tk, shares, price, amount, strategy,
  }];

  const posCsv = serializePositions(newPositions);
  const txnsCsv = serializeTransactions(newTxns);

  const btn = document.getElementById("buy-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
    }, `BUY ${tk} [${strategy}]: ${shares} @ $${price} on ${date}`);
    state.positions = newPositions;
    state.transactions = newTxns;
    document.getElementById("buy-shares").value = "";
    document.getElementById("buy-price").value = "";
    document.getElementById("buy-ticker").value = "";
    delete document.getElementById("buy-ticker").dataset.selectedTicker;
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    updateBuySummary();
    toast(`BUY ${tk} [${strategy.toUpperCase()}]: ${shares} × ${fmtMoney(price)} = ${fmtMoney(amount)}`, "good");
  } catch (e) {
    toast("Commit error: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Record Buy";
  }
}

async function submitSell() {
  const key = document.getElementById("sell-ticker").value;
  const shares = parseFloat(document.getElementById("sell-shares").value);
  const price = parseFloat(document.getElementById("sell-price").value);
  const date = document.getElementById("sell-date").value || todayIso();
  if (!key || !shares || !price) { toast("Fill all fields", "bad"); return; }
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }

  const [tk, strat] = key.split("|");
  const pos = state.positions.find(p => p.ticker === tk && p.strategy === strat);
  if (!pos || pos.shares < shares) { toast("Not enough shares in position", "bad"); return; }

  const proceeds = shares * price;
  const cost_per_share = pos.cost_basis / pos.shares;
  const cost_removed = cost_per_share * shares;

  const newPositions = state.positions
    .map(p => {
      if (p.ticker !== tk || p.strategy !== strat) return p;
      const remaining_shares = p.shares - shares;
      if (remaining_shares < 1e-6) return null; // delete fully closed
      return { ...p, shares: remaining_shares, cost_basis: p.cost_basis - cost_removed };
    })
    .filter(Boolean);

  const newTxns = [...state.transactions, {
    date, action: "SELL", ticker: tk, shares, price, amount: proceeds, strategy: strat,
  }];

  const posCsv = serializePositions(newPositions);
  const txnsCsv = serializeTransactions(newTxns);

  const btn = document.getElementById("sell-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
    }, `SELL ${tk} [${strat}]: ${shares} @ $${price} on ${date}`);
    state.positions = newPositions;
    state.transactions = newTxns;
    document.getElementById("sell-shares").value = "";
    document.getElementById("sell-price").value = "";
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    updateSellSummary();
    toast(`SELL ${tk} [${strat.toUpperCase()}]: ${shares} × ${fmtMoney(price)} = ${fmtMoney(proceeds)}`, "good");
  } catch (e) {
    toast("Commit error: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Record Sell";
  }
}

// ---------- CSV Import ----------
const HEADER_ALIASES = {
  date: ["date", "tarih", "trade_date", "execution_date", "time"],
  action: ["action", "side", "type", "transaction_type", "buy_sell"],
  ticker: ["ticker", "symbol", "instrument", "isin"],
  shares: ["shares", "quantity", "qty", "no_of_shares"],
  price: ["price", "exec_price", "share_price", "price_per_share"],
  amount: ["amount", "total", "total_value", "value"],
};

function normalizeHeader(h) {
  const hl = h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "");
  for (const [canonical, aliases] of Object.entries(HEADER_ALIASES)) {
    if (aliases.includes(hl)) return canonical;
  }
  return null;
}

function parseImportCsv(text, strategy) {
  const { headers, rows } = csvParse(text);
  const colMap = {};
  headers.forEach((h, i) => {
    const c = normalizeHeader(h);
    if (c) colMap[c] = i;
  });

  // Trade Republic uses both `category` (TRADING / CORPORATE_ACTION) and
  // `type` (BUY / SELL / REVERSE_SPLIT). We want only TRADING / BUY|SELL.
  // Find category column by scanning normalized headers for "category".
  const categoryColIdx = headers.findIndex(h =>
    h.toLowerCase().replace(/[^a-z0-9_]/g, "_").replace(/^_+|_+$/g, "") === "category");
  const isBuyish  = (a) => ["BUY", "PURCHASE", "ALIM"].includes(a) || a === "B";
  const isSellish = (a) => ["SELL", "SALE", "SATIS"].includes(a) || a === "S";

  const out = [];
  let skippedNonTrade = 0, skippedBadData = 0;
  for (const r of rows) {
    if (categoryColIdx >= 0) {
      const cat = (r[headers[categoryColIdx]] || "").toUpperCase().trim();
      if (cat && cat !== "TRADING") { skippedNonTrade++; continue; }
    }
    const action = (r[headers[colMap.action]] || "").toUpperCase().trim();
    const isBuy = isBuyish(action);
    const isSell = isSellish(action);
    if (!isBuy && !isSell) { skippedNonTrade++; continue; }

    const tickerOrIsin = (r[headers[colMap.ticker]] || "").toUpperCase().trim();
    if (!tickerOrIsin) { skippedBadData++; continue; }

    const sharesRaw = parseFloat(r[headers[colMap.shares]] || "0");
    const price = parseFloat(r[headers[colMap.price]] || "0");
    if (!sharesRaw || !price) { skippedBadData++; continue; }
    const shares = Math.abs(sharesRaw);   // T212 emits negative shares for SELL

    let date = r[headers[colMap.date]] || todayIso();
    date = date.split("T")[0].replace(/[./]/g, "-");
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      const [d, m, y] = date.split("-");
      date = `${y}-${m}-${d}`;
    }

    out.push({
      date,
      action: isBuy ? "BUY" : "SELL",
      ticker: tickerOrIsin,
      shares,
      price,
      amount: shares * price,
      strategy,
    });
  }
  // Stash diagnostics for the preview UI
  out._diag = { totalRows: rows.length, kept: out.length, skippedNonTrade, skippedBadData };
  return out;
}

function previewCsv(rows) {
  const div = document.getElementById("csv-preview");
  const submitBtn = document.getElementById("csv-submit");
  const d = rows && rows._diag;
  if (!rows || rows.length === 0) {
    let msg = `<p class="muted">No BUY/SELL rows detected.`;
    if (d) {
      msg += ` Parsed <strong>${d.totalRows}</strong> rows total —
        skipped <strong>${d.skippedNonTrade}</strong> non-trade rows
        (DEPOSIT, REVERSE_SPLIT, etc.) and
        <strong>${d.skippedBadData}</strong> rows with missing ticker / shares / price.`;
    }
    msg += `</p>`;
    div.innerHTML = msg;
    submitBtn.classList.add("hidden");
    return;
  }
  let header = `<p class="muted">Importing <strong>${rows.length}</strong> trade(s)`;
  if (d && d.skippedNonTrade) header += ` (skipped ${d.skippedNonTrade} non-trade rows)`;
  header += `.</p>`;
  div.innerHTML = header +
    '<div class="preview-row header"><div>Date</div><div>Action</div><div>Ticker</div><div>Shares</div><div>Price</div><div>Amount</div></div>';
  for (const r of rows) {
    const row = document.createElement("div");
    row.className = "preview-row";
    row.innerHTML = `
      <div>${r.date}</div>
      <div style="color:${r.action === 'BUY' ? '#10B981' : '#EF4444'}">${r.action}</div>
      <div><strong>${r.ticker}</strong></div>
      <div>${r.shares}</div>
      <div>${fmtMoney(r.price)}</div>
      <div>${fmtMoney(r.amount)}</div>`;
    div.appendChild(row);
  }
  submitBtn.classList.remove("hidden");
  submitBtn.textContent = `Confirm and Commit (${rows.length})`;
}

async function commitCsvImport() {
  if (!state.pendingCsvRows || state.pendingCsvRows.length === 0) return;
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }

  const newPositions = [...state.positions];
  const newTxns = [...state.transactions];

  for (const r of state.pendingCsvRows) {
    if (r.action === "BUY") {
      const existing = newPositions.find(p => p.ticker === r.ticker && p.strategy === r.strategy);
      const sector = (state.tickerIndex.find(x => x.t === r.ticker) || {}).s
                     || (existing ? existing.sector : "Other");
      if (existing) {
        existing.shares += r.shares;
        existing.cost_basis += r.amount;
        if (!existing.first_buy_date) existing.first_buy_date = r.date;
      } else {
        newPositions.push({
          ticker: r.ticker, shares: r.shares, cost_basis: r.amount,
          first_buy_date: r.date, sector, strategy: r.strategy,
        });
      }
      newTxns.push(r);
    } else if (r.action === "SELL") {
      const idx = newPositions.findIndex(p => p.ticker === r.ticker && p.strategy === r.strategy);
      if (idx >= 0) {
        const pos = newPositions[idx];
        const cps = pos.cost_basis / pos.shares;
        const remaining = pos.shares - r.shares;
        if (remaining < 1e-6) {
          newPositions.splice(idx, 1);
        } else {
          pos.shares = remaining;
          pos.cost_basis -= cps * r.shares;
        }
      }
      newTxns.push(r);
    }
  }

  const posCsv = serializePositions(newPositions);
  const txnsCsv = serializeTransactions(newTxns);

  const btn = document.getElementById("csv-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  const importedCount = state.pendingCsvRows.length;
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
    }, `CSV import: ${importedCount} transactions`);
    state.positions = newPositions;
    state.transactions = newTxns;
    state.pendingCsvRows = null;
    document.getElementById("csv-preview").innerHTML = "";
    document.getElementById("csv-file").value = "";
    btn.classList.add("hidden");
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    toast(`${importedCount} transactions committed`, "good");
  } catch (e) {
    toast("Commit error: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Confirm and Commit";
  }
}

// ---------- Inline edit / delete ----------
function startEditPosition(ticker) {
  const row = document.querySelector(`#positions-table tbody tr[data-ticker="${ticker}"]`);
  if (!row) return;
  const p = state.positions.find(x => x.ticker === ticker);
  if (!p) return;
  row.classList.add("editing");
  row.innerHTML = `
    <td><strong>${p.ticker}</strong>
      <div class="muted" style="font-size:11px;">
        <input type="date" data-f="first_buy_date" value="${p.first_buy_date || ""}">
      </div></td>
    <td><input type="text" data-f="sector" value="${p.sector || ""}"></td>
    <td class="num"><input type="number" step="0.0001" data-f="shares" value="${p.shares}"></td>
    <td class="num"><input type="number" step="0.01" data-f="cost_basis" value="${p.cost_basis}"></td>
    <td colspan="5" class="muted" style="font-size:12px;">live values recompute on save</td>
    <td class="actions">
      <button class="row-action" data-act="save-pos" data-ticker="${p.ticker}" title="Save">💾</button>
      <button class="row-action" data-act="cancel-pos" title="Cancel">✖</button>
    </td>`;
}

async function savePositionEdit(ticker) {
  const row = document.querySelector(`#positions-table tbody tr[data-ticker="${ticker}"]`);
  if (!row) return;
  const p = state.positions.find(x => x.ticker === ticker);
  if (!p) return;
  const f = (k) => row.querySelector(`[data-f="${k}"]`)?.value;
  const updated = {
    ...p,
    shares: parseFloat(f("shares")) || 0,
    cost_basis: parseFloat(f("cost_basis")) || 0,
    first_buy_date: f("first_buy_date") || p.first_buy_date,
    sector: f("sector") || p.sector,
  };
  if (updated.shares <= 0) {
    toast("Shares must be > 0 (use delete to remove the position)", "bad");
    return;
  }
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }

  const newPositions = state.positions.map(x =>
    (x.ticker === p.ticker && x.strategy === p.strategy) ? updated : x);
  const posCsv = serializePositions(newPositions);
  try {
    await ghCommitMultiFile({ "positions.csv": posCsv },
      `Edit ${p.ticker}: ${p.shares}→${updated.shares} shares, $${p.cost_basis.toFixed(2)}→$${updated.cost_basis.toFixed(2)}`);
    state.positions = newPositions;
    renderPortfolio();
    refreshSellDropdown();
    toast(`Updated ${p.ticker}`, "good");
  } catch (e) {
    toast("Save failed: " + e.message, "bad");
  }
}

async function deletePosition(ticker) {
  const p = state.positions.find(x => x.ticker === ticker);
  if (!p) return;
  if (!confirm(`Delete ${ticker} (${p.shares.toFixed(4)} shares, $${p.cost_basis.toFixed(2)} cost)? Existing transactions are kept.`)) return;
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }
  const newPositions = state.positions.filter(x => x.ticker !== p.ticker);
  const posCsv = serializePositions(newPositions);
  try {
    await ghCommitMultiFile({ "positions.csv": posCsv }, `Delete position ${ticker}`);
    state.positions = newPositions;
    renderPortfolio();
    refreshSellDropdown();
    toast(`Deleted ${ticker}`, "good");
  } catch (e) {
    toast("Delete failed: " + e.message, "bad");
  }
}

function startEditTransaction(idx) {
  const row = document.querySelector(`#transactions-table tbody tr[data-idx="${idx}"]`);
  if (!row) return;
  const t = state.transactions[idx];
  if (!t) return;
  row.classList.add("editing");
  row.innerHTML = `
    <td><input type="date" data-f="date" value="${t.date}"></td>
    <td><select data-f="action">
      ${["BUY","SELL","DEPOSIT"].map(a => `<option value="${a}" ${t.action===a?"selected":""}>${a}</option>`).join("")}
    </select></td>
    <td><input type="text" data-f="ticker" value="${t.ticker || ""}" placeholder="e.g. MTCH"></td>
    <td class="num"><input type="number" step="0.0001" data-f="shares" value="${t.shares || 0}"></td>
    <td class="num"><input type="number" step="0.01" data-f="price" value="${t.price || 0}"></td>
    <td class="num"><input type="number" step="0.01" data-f="amount" value="${t.amount || 0}"></td>
    <td class="actions">
      <button class="row-action" data-act="save-txn" data-idx="${idx}" title="Save">💾</button>
      <button class="row-action" data-act="cancel-txn" title="Cancel">✖</button>
    </td>`;
}

async function saveTransactionEdit(idx) {
  const row = document.querySelector(`#transactions-table tbody tr[data-idx="${idx}"]`);
  if (!row) return;
  const t = state.transactions[idx];
  if (!t) return;
  const f = (k) => row.querySelector(`[data-f="${k}"]`)?.value;
  const updated = {
    ...t,
    date: f("date") || t.date,
    action: f("action") || t.action,
    ticker: (f("ticker") || "").toUpperCase().trim(),
    shares: parseFloat(f("shares")) || 0,
    price: parseFloat(f("price")) || 0,
    amount: parseFloat(f("amount")) || 0,
  };
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }
  const newTxns = state.transactions.map((x, i) => i === idx ? updated : x);
  const txnsCsv = serializeTransactions(newTxns);
  try {
    await ghCommitMultiFile({ "transactions.csv": txnsCsv },
      `Edit txn ${updated.date} ${updated.action} ${updated.ticker || ""}`);
    state.transactions = newTxns;
    renderTransactions();
    toast("Transaction updated", "good");
  } catch (e) {
    toast("Save failed: " + e.message, "bad");
  }
}

async function deleteTransaction(idx) {
  const t = state.transactions[idx];
  if (!t) return;
  const desc = `${t.date} ${t.action} ${t.ticker || ""} $${t.amount.toFixed(2)}`;
  if (!confirm(`Delete transaction "${desc}"? Position rows are NOT recomputed — edit positions separately if needed.`)) return;
  if (!getToken()) { showTokenSetup(true); toast("Add token first", "bad"); return; }
  const newTxns = state.transactions.filter((_, i) => i !== idx);
  const txnsCsv = serializeTransactions(newTxns);
  try {
    await ghCommitMultiFile({ "transactions.csv": txnsCsv }, `Delete txn ${desc}`);
    state.transactions = newTxns;
    renderTransactions();
    toast("Transaction deleted", "good");
  } catch (e) {
    toast("Delete failed: " + e.message, "bad");
  }
}

function setupRowActions() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-act]");
    if (!btn) return;
    const act = btn.dataset.act;
    const ticker = btn.dataset.ticker;
    const idx = btn.dataset.idx ? parseInt(btn.dataset.idx, 10) : null;
    if (act === "edit-pos") startEditPosition(ticker);
    else if (act === "save-pos") savePositionEdit(ticker);
    else if (act === "cancel-pos") renderPortfolio();
    else if (act === "del-pos") deletePosition(ticker);
    else if (act === "edit-txn") startEditTransaction(idx);
    else if (act === "save-txn") saveTransactionEdit(idx);
    else if (act === "cancel-txn") renderTransactions();
    else if (act === "del-txn") deleteTransaction(idx);
  });
}

// ---------- Parqet CSV export ----------
// Mirrors the 23-column Trade Republic export format that Parqet ingests.
// Only BUY/SELL trades are exported; DEPOSITs and corporate actions are skipped.
const PARQET_HEADERS = [
  "datetime", "date", "account_type", "category", "type", "asset_class",
  "name", "symbol", "shares", "price", "amount", "fee", "tax", "currency",
  "original_amount", "original_currency", "fx_rate", "description",
  "transaction_id", "counterparty_name", "counterparty_iban",
  "payment_reference", "mcc_code",
];

function uuid4() {
  // Browser-native when available; else fallback
  if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function csvQuote(v) {
  if (v === null || v === undefined) return '""';
  return `"${String(v).replace(/"/g, '""')}"`;
}

function generateParqetCsv() {
  const lines = [PARQET_HEADERS.map(csvQuote).join(",")];
  let n = 0;
  for (const t of state.transactions) {
    if (t.action !== "BUY" && t.action !== "SELL") continue;
    const isBuy = t.action === "BUY";
    const meta = state.tickerIndex.find(x => x.t === t.ticker) || {};
    const name = meta.n || t.ticker;

    // datetime: noon UTC for determinism (date column is the truth)
    const datetime = `${t.date}T12:00:00.000Z`;

    // Sign conventions match the Trade Republic export:
    //   BUY:  shares positive, amount negative (cash out)
    //   SELL: shares negative, amount positive (cash in)
    const sharesStr = (isBuy ? t.shares : -t.shares).toFixed(10);
    const amountStr = (isBuy ? -t.amount : t.amount).toFixed(2);
    const priceStr  = t.price.toFixed(10);

    const desc = `${isBuy ? "Buy" : "Sell"} trade ${t.ticker} ${name}, quantity: ${t.shares}`;

    const row = [
      datetime,           // datetime
      t.date,             // date
      "DEFAULT",          // account_type
      "TRADING",          // category
      t.action,           // type (BUY / SELL)
      "STOCK",            // asset_class
      name,               // name
      t.ticker,           // symbol (ticker — Parqet typically auto-resolves US names)
      sharesStr,          // shares
      priceStr,           // price
      amountStr,          // amount
      "",                 // fee (we don't track)
      "",                 // tax
      "USD",              // currency (T212 USD account)
      "",                 // original_amount
      "",                 // original_currency
      "",                 // fx_rate
      desc,               // description
      uuid4(),            // transaction_id
      "", "", "", "",     // counterparty_name, _iban, payment_reference, mcc_code
    ];
    lines.push(row.map(csvQuote).join(","));
    n++;
  }
  return { csv: lines.join("\n") + "\n", count: n };
}

function downloadParqetCsv() {
  const { csv, count } = generateParqetCsv();
  if (count === 0) {
    toast("No BUY/SELL trades to export yet", "bad");
    return;
  }
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `parqet_export_${todayIso()}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast(`Downloaded ${count} trades to Parqet CSV`, "good");
}

// ---------- Bootstrap ----------
async function init() {
  setupTabs();
  setupTickerSearch();
  setupRowActions();
  await loadTickerIndex();

  if (!getToken()) {
    showTokenSetup(true);
    document.getElementById("status").textContent = "Waiting for token (private repo)";
  } else {
    await loadState();
  }

  // Wire up handlers
  document.getElementById("token-save").addEventListener("click", async () => {
    const t = document.getElementById("token-input").value.trim();
    if (!t) return;
    saveToken(t);
    showTokenSetup(false);
    document.getElementById("token-input").value = "";
    toast("Token saved, loading data...", "good");
    await loadState();
  });
  document.getElementById("logout-btn").addEventListener("click", () => {
    clearToken();
    showTokenSetup(true);
    toast("Token cleared");
  });
  document.getElementById("refresh-btn").addEventListener("click", async () => {
    await loadState();
    refreshLivePrices();
  });
  document.getElementById("refresh-prices").addEventListener("click", refreshLivePrices);

  document.getElementById("buy-submit").addEventListener("click", submitBuy);
  document.getElementById("sell-submit").addEventListener("click", submitSell);
  document.getElementById("csv-submit").addEventListener("click", commitCsvImport);
  document.getElementById("parqet-download").addEventListener("click", downloadParqetCsv);

  ["buy-shares", "buy-price"].forEach(id =>
    document.getElementById(id).addEventListener("input", updateBuySummary));
  ["sell-shares", "sell-price"].forEach(id =>
    document.getElementById(id).addEventListener("input", updateSellSummary));
  document.getElementById("sell-ticker").addEventListener("change", updateSellSummary);

  document.getElementById("csv-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      state.pendingCsvRows = parseImportCsv(text, csvStrategySelected());
      previewCsv(state.pendingCsvRows);
      if (state.pendingCsvRows.length === 0) {
        toast(`No trades found in ${f.name}`, "bad");
      } else {
        toast(`Detected ${state.pendingCsvRows.length} trades — review and commit`, "good");
      }
    } catch (err) {
      console.error("CSV parse:", err);
      toast("CSV parse error: " + (err.message || err), "bad");
      document.getElementById("csv-preview").innerHTML =
        `<p class="muted">Parse failed: ${err.message || err}</p>`;
      document.getElementById("csv-submit").classList.add("hidden");
    }
  });

  // Default dates to today
  const today = todayIso();
  ["buy-date", "sell-date"].forEach(id => document.getElementById(id).value = today);
}

init();
