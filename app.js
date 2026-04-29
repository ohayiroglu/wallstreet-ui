// Wallstreet Portfolio Manager — static GitHub Pages app
// Reads/writes positions.csv, transactions.csv, cash.json on github.com/ohayiroglu/wallstreet-state via the GitHub API.
// Tracks two parallel strategies: DCF (quarterly fair-value) and GPM (monthly margin-acceleration).

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
  activeStrategy: "all",  // "all" | "dcf" | "gpm"
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

// ---------- Strategy helpers ----------
function normalizeStrategy(s) {
  // Backwards compat: empty/missing strategy → "dcf" (existing rows pre-multi-strategy era)
  const v = (s || "").toString().trim().toLowerCase();
  return (v === "gpm") ? "gpm" : "dcf";
}

function buyStrategySelected() {
  const r = document.querySelector("input[name='buy-strategy']:checked");
  return r ? r.value : "dcf";
}

function csvStrategySelected() {
  const r = document.querySelector("input[name='csv-strategy']:checked");
  return r ? r.value : "dcf";
}

function setActiveStrategy(s) {
  state.activeStrategy = s;
  document.querySelectorAll(".strategy-pills .pill").forEach(p => {
    p.classList.toggle("active", p.dataset.strategy === s);
  });
  renderPortfolio();
  refreshSellDropdown();
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
function csvParse(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0].split(",").map(h => h.trim());
  const rows = lines.slice(1).filter(l => l.trim()).map(l => {
    const cols = l.split(",");
    const obj = {};
    headers.forEach((h, i) => obj[h] = (cols[i] || "").trim());
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
    const dcfCount = state.positions.filter(p => p.strategy === "dcf").length;
    const gpmCount = state.positions.filter(p => p.strategy === "gpm").length;
    document.getElementById("status").textContent =
      `${dcfCount} DCF • ${gpmCount} GPM • ${state.transactions.length} transactions`;
  } catch (e) {
    toast("Load error: " + e.message, "bad");
    document.getElementById("status").textContent = "ERROR";
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
      strategy: p.strategy || "dcf",
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
      strategy: t.action === "DEPOSIT" ? "" : (t.strategy || "dcf"),
    })),
    ["date", "action", "ticker", "shares", "price", "amount", "strategy"]
  );
}

// ---------- Render ----------
function fmtMoney(v) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
}

function strategyBadge(s) {
  const norm = normalizeStrategy(s);
  return `<span class="strategy-badge ${norm}">${norm.toUpperCase()}</span>`;
}

function filteredPositions() {
  if (state.activeStrategy === "all") return state.positions;
  return state.positions.filter(p => p.strategy === state.activeStrategy);
}

function renderPortfolio() {
  const tbody = document.querySelector("#positions-table tbody");
  const emptyEl = document.getElementById("empty-positions");
  const tableEl = document.getElementById("positions-table");
  tbody.innerHTML = "";
  const filtered = filteredPositions();
  const sorted = [...filtered].sort((a, b) => b.cost_basis - a.cost_basis);
  for (const p of sorted) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${p.ticker}</strong></td>
      <td>${strategyBadge(p.strategy)}</td>
      <td>${p.shares.toFixed(4).replace(/\.?0+$/, "")}</td>
      <td>${fmtMoney(p.cost_basis)}</td>
      <td>${p.first_buy_date}</td>
      <td>${p.sector}</td>`;
    tbody.appendChild(row);
  }
  if (sorted.length === 0) {
    tableEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  } else {
    tableEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
  }

  // Stats: split by strategy (cash & contributed removed from UI 2026-04-29)
  const dcfCost = state.positions.filter(p => p.strategy === "dcf").reduce((s, p) => s + p.cost_basis, 0);
  const gpmCost = state.positions.filter(p => p.strategy === "gpm").reduce((s, p) => s + p.cost_basis, 0);
  const totalCost = dcfCost + gpmCost;
  document.getElementById("dcf-value").textContent = fmtMoney(dcfCost);
  document.getElementById("gpm-value").textContent = fmtMoney(gpmCost);
  document.getElementById("total-value").textContent = fmtMoney(totalCost);

  // Title reflects active strategy
  const title = document.getElementById("portfolio-title");
  if (state.activeStrategy === "dcf") title.textContent = "💎 DCF Portfolio";
  else if (state.activeStrategy === "gpm") title.textContent = "📈 GPM Portfolio";
  else title.textContent = "Portfolio (All)";
}

function renderTransactions() {
  const tbody = document.querySelector("#transactions-table tbody");
  tbody.innerHTML = "";
  // Filter recent transactions by active strategy too (DEPOSIT shows in all views)
  let txns = [...state.transactions];
  if (state.activeStrategy !== "all") {
    txns = txns.filter(t => t.action === "DEPOSIT" || t.strategy === state.activeStrategy);
  }
  const recent = txns.sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  for (const t of recent) {
    const row = document.createElement("tr");
    const actionColor = t.action === "BUY" ? "#10B981" : t.action === "SELL" ? "#EF4444" : "#94A3B8";
    const stratCell = t.action === "DEPOSIT" ? '<span class="muted">—</span>' : strategyBadge(t.strategy);
    row.innerHTML = `
      <td>${t.date}</td>
      <td style="color:${actionColor}">${t.action}</td>
      <td>${stratCell}</td>
      <td>${t.ticker || ""}</td>
      <td>${t.shares ? t.shares.toFixed(4).replace(/\.?0+$/, "") : ""}</td>
      <td>${t.price ? fmtMoney(t.price) : ""}</td>
      <td>${fmtMoney(t.amount)}</td>`;
    tbody.appendChild(row);
  }
}

function refreshSellDropdown() {
  const sel = document.getElementById("sell-ticker");
  sel.innerHTML = '<option value="">— select —</option>';
  // Sell dropdown uses ticker:strategy as key so we can sell from the right pool
  const sellable = state.activeStrategy === "all"
    ? state.positions
    : state.positions.filter(p => p.strategy === state.activeStrategy);
  for (const p of sellable) {
    const opt = document.createElement("option");
    const key = `${p.ticker}|${p.strategy}`;
    opt.value = key;
    const stratLabel = p.strategy.toUpperCase();
    opt.textContent = `${p.ticker} [${stratLabel}] (${p.shares.toFixed(4).replace(/\.?0+$/, "")} shares)`;
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
    const [tk, strat] = key.split("|");
    const total = s * p;
    const pos = state.positions.find(x => x.ticker === tk && x.strategy === strat);
    const remaining = pos ? (pos.shares - s).toFixed(4) : "?";
    sum.textContent = `Proceeds: ${fmtMoney(total)} • Remaining: ${remaining} ${tk} (${strat.toUpperCase()})`;
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

function setupStrategyPills() {
  document.querySelectorAll(".strategy-pills .pill").forEach(p => {
    p.addEventListener("click", () => setActiveStrategy(p.dataset.strategy));
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

  const out = [];
  for (const r of rows) {
    const action = (r[Object.keys(r)[colMap.action]] || "").toUpperCase().trim();
    const isBuy = ["BUY", "B", "PURCHASE", "ALIM"].some(a => action.includes(a));
    const isSell = ["SELL", "S", "SALE", "SATIS"].some(a => action.includes(a));
    if (!isBuy && !isSell) continue;
    const ticker = (r[Object.keys(r)[colMap.ticker]] || "").toUpperCase().trim();
    if (!ticker) continue;
    const shares = parseFloat(r[Object.keys(r)[colMap.shares]] || "0");
    const price = parseFloat(r[Object.keys(r)[colMap.price]] || "0");
    if (!shares || !price) continue;
    let date = r[Object.keys(r)[colMap.date]] || todayIso();
    date = date.split("T")[0].replace(/[./]/g, "-");
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      const [d, m, y] = date.split("-");
      date = `${y}-${m}-${d}`;
    }
    out.push({
      date, action: isBuy ? "BUY" : "SELL",
      ticker, shares, price, amount: shares * price,
      strategy,
    });
  }
  return out;
}

function previewCsv(rows) {
  const div = document.getElementById("csv-preview");
  if (!rows || rows.length === 0) {
    div.innerHTML = '<p class="muted">No processable rows found.</p>';
    document.getElementById("csv-submit").classList.add("hidden");
    return;
  }
  const stratLabel = (rows[0] && rows[0].strategy ? rows[0].strategy.toUpperCase() : "DCF");
  div.innerHTML = `<p class="muted">Tagging all rows as <strong>${stratLabel}</strong>.</p>` +
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
  document.getElementById("csv-submit").classList.remove("hidden");
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
  setupStrategyPills();
  setupTickerSearch();
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
  document.getElementById("refresh-btn").addEventListener("click", loadState);

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
    const text = await f.text();
    state.pendingCsvRows = parseImportCsv(text, csvStrategySelected());
    previewCsv(state.pendingCsvRows);
  });

  // Default dates to today
  const today = todayIso();
  ["buy-date", "sell-date"].forEach(id => document.getElementById(id).value = today);
}

init();
