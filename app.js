// Wallstreet Portfolio Manager — static GitHub Pages app
// Reads/writes positions.csv, transactions.csv, cash.json on github.com/ohayiroglu/wallstreet-state via the GitHub API.

const REPO = "ohayiroglu/wallstreet-state";
const BRANCH = "main";
const RAW_BASE = `https://raw.githubusercontent.com/${REPO}/${BRANCH}/`;
const API_BASE = `https://api.github.com/repos/${REPO}`;

// In-memory state
const state = {
  cash: { cash: 0, total_contributed: 0, last_contribution_date: null },
  positions: [],   // [{ticker, shares, cost_basis, first_buy_date, sector}]
  transactions: [], // [{date, action, ticker, shares, price, amount}]
  tickerIndex: [],  // [{t, n, s}]
  pendingCsvRows: null,
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

// ---------- GitHub API ----------
async function ghFetchRaw(path) {
  // API contents endpoint with Accept: raw — works for both public and private
  // repos when an auth token is present.
  const token = getToken();
  const headers = { Accept: "application/vnd.github.raw" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${API_BASE}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`;
  const res = await fetch(url, { headers, cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`fetch ${path} failed: ${res.status}`);
  return res.text();
}

async function ghGetFileSha(path) {
  // Need sha for PUT/commit
  const res = await fetch(`${API_BASE}/contents/${path}?ref=${BRANCH}&_=${Date.now()}`, {
    headers: { Authorization: `Bearer ${getToken()}`, Accept: "application/vnd.github+json" },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`get sha failed: ${res.status} ${await res.text()}`);
  const j = await res.json();
  return j.sha;
}

async function ghCommitMultiFile(filesMap, message) {
  // filesMap: { "path/in/repo": "string content", ... }
  // Uses Git Database API to create one atomic commit covering all files.
  const token = getToken();
  if (!token) throw new Error("no token");
  const headers = { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "Content-Type": "application/json" };

  // 1. Get current ref
  const refRes = await fetch(`${API_BASE}/git/refs/heads/${BRANCH}`, { headers });
  if (!refRes.ok) throw new Error(`ref fetch: ${refRes.status} ${await refRes.text()}`);
  const refJ = await refRes.json();
  const parentSha = refJ.object.sha;

  // 2. Get parent commit -> tree sha
  const commitRes = await fetch(`${API_BASE}/git/commits/${parentSha}`, { headers });
  if (!commitRes.ok) throw new Error(`commit fetch: ${commitRes.status}`);
  const commitJ = await commitRes.json();
  const baseTree = commitJ.tree.sha;

  // 3. Create blobs
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

  // 4. Create tree
  const treeRes = await fetch(`${API_BASE}/git/trees`, {
    method: "POST",
    headers,
    body: JSON.stringify({ base_tree: baseTree, tree: treeEntries }),
  });
  if (!treeRes.ok) throw new Error(`tree: ${treeRes.status} ${await treeRes.text()}`);
  const treeJ = await treeRes.json();

  // 5. Create commit
  const newCommitRes = await fetch(`${API_BASE}/git/commits`, {
    method: "POST",
    headers,
    body: JSON.stringify({ message, tree: treeJ.sha, parents: [parentSha] }),
  });
  if (!newCommitRes.ok) throw new Error(`commit create: ${newCommitRes.status} ${await newCommitRes.text()}`);
  const newCommitJ = await newCommitRes.json();

  // 6. Update ref
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
  // Simple CSV parser — assumes no embedded commas/quotes
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
  document.getElementById("status").textContent = "GitHub'dan okunuyor...";
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
    document.getElementById("last-sync").textContent = "Senkron: " + new Date().toLocaleTimeString();
    document.getElementById("status").textContent = `Pozisyon: ${state.positions.length} • İşlem: ${state.transactions.length}`;
  } catch (e) {
    toast("Yükleme hatası: " + e.message, "bad");
    document.getElementById("status").textContent = "HATA";
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
  }));
}

function serializePositions() {
  return csvStringify(
    state.positions.map(p => ({
      ticker: p.ticker,
      shares: p.shares.toFixed(6).replace(/\.?0+$/, ""),
      cost_basis: p.cost_basis.toFixed(2),
      first_buy_date: p.first_buy_date,
      sector: p.sector,
    })),
    ["ticker", "shares", "cost_basis", "first_buy_date", "sector"]
  );
}

function serializeTransactions() {
  return csvStringify(
    state.transactions.map(t => ({
      date: t.date,
      action: t.action,
      ticker: t.ticker,
      shares: t.shares.toFixed(6).replace(/\.?0+$/, ""),
      price: t.price.toFixed(4).replace(/\.?0+$/, ""),
      amount: t.amount.toFixed(2),
    })),
    ["date", "action", "ticker", "shares", "price", "amount"]
  );
}

// ---------- Render ----------
function fmtMoney(v) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 }).format(v);
}

function renderPortfolio() {
  const tbody = document.querySelector("#positions-table tbody");
  tbody.innerHTML = "";
  const sorted = [...state.positions].sort((a, b) => b.cost_basis - a.cost_basis);
  for (const p of sorted) {
    const row = document.createElement("tr");
    row.innerHTML = `
      <td><strong>${p.ticker}</strong></td>
      <td>${p.shares.toFixed(4).replace(/\.?0+$/, "")}</td>
      <td>${fmtMoney(p.cost_basis)}</td>
      <td>${p.first_buy_date}</td>
      <td>${p.sector}</td>`;
    tbody.appendChild(row);
  }
  const totalCost = state.positions.reduce((s, p) => s + p.cost_basis, 0);
  document.getElementById("cash-balance").textContent = fmtMoney(state.cash.cash);
  document.getElementById("total-value").textContent = fmtMoney(totalCost + state.cash.cash) + " (cost)";
  document.getElementById("total-contributed").textContent = fmtMoney(state.cash.total_contributed);
}

function renderTransactions() {
  const tbody = document.querySelector("#transactions-table tbody");
  tbody.innerHTML = "";
  const recent = [...state.transactions].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20);
  for (const t of recent) {
    const row = document.createElement("tr");
    const actionColor = t.action === "BUY" ? "#10B981" : t.action === "SELL" ? "#EF4444" : "#94A3B8";
    row.innerHTML = `
      <td>${t.date}</td>
      <td style="color:${actionColor}">${t.action}</td>
      <td>${t.ticker || ""}</td>
      <td>${t.shares ? t.shares.toFixed(4).replace(/\.?0+$/, "") : ""}</td>
      <td>${t.price ? fmtMoney(t.price) : ""}</td>
      <td>${fmtMoney(t.amount)}</td>`;
    tbody.appendChild(row);
  }
}

function refreshSellDropdown() {
  const sel = document.getElementById("sell-ticker");
  sel.innerHTML = '<option value="">— seç —</option>';
  for (const p of state.positions) {
    const opt = document.createElement("option");
    opt.value = p.ticker;
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
  // Prioritize exact ticker match, then prefix on ticker, then prefix on name, then substring
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
      dropdown.innerHTML = '<div class="dropdown-item muted">Eşleşme yok</div>';
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
    sum.textContent = `Toplam: ${fmtMoney(total)} • Cash sonrası: ${fmtMoney(state.cash.cash - total)}`;
  } else {
    sum.textContent = "";
  }
}

function updateSellSummary() {
  const t = document.getElementById("sell-ticker").value;
  const s = parseFloat(document.getElementById("sell-shares").value) || 0;
  const p = parseFloat(document.getElementById("sell-price").value) || 0;
  const sum = document.getElementById("sell-summary");
  if (t && s && p) {
    const total = s * p;
    const pos = state.positions.find(x => x.ticker === t);
    const remaining = pos ? (pos.shares - s).toFixed(4) : "?";
    sum.textContent = `Tahsilat: ${fmtMoney(total)} • Kalan: ${remaining} shares`;
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

async function submitCash() {
  const amt = parseFloat(document.getElementById("cash-amount").value);
  const date = document.getElementById("cash-date").value || todayIso();
  if (!amt || amt <= 0) { toast("Geçerli bir tutar gir", "bad"); return; }
  if (!getToken()) { showTokenSetup(true); toast("Önce token ekle", "bad"); return; }

  const newCash = { ...state.cash };
  newCash.cash = (newCash.cash || 0) + amt;
  newCash.total_contributed = (newCash.total_contributed || 0) + amt;
  newCash.last_contribution_date = date;

  const newTxns = [...state.transactions, {
    date, action: "DEPOSIT", ticker: "", shares: 0, price: 0, amount: amt,
  }];

  const tmpState = { ...state, cash: newCash, transactions: newTxns };
  const txnsCsv = csvStringify(
    tmpState.transactions.map(t => ({
      date: t.date, action: t.action, ticker: t.ticker || "",
      shares: t.shares ? t.shares.toFixed(6).replace(/\.?0+$/, "") : "0",
      price: t.price ? t.price.toFixed(4).replace(/\.?0+$/, "") : "0",
      amount: (t.amount || 0).toFixed(2),
    })),
    ["date", "action", "ticker", "shares", "price", "amount"]
  );

  const btn = document.getElementById("cash-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "cash.json": JSON.stringify(newCash, null, 2) + "\n",
      "transactions.csv": txnsCsv,
    }, `Cash deposit: $${amt.toFixed(2)} on ${date}`);
    state.cash = newCash;
    state.transactions = newTxns;
    document.getElementById("cash-amount").value = "";
    renderPortfolio();
    renderTransactions();
    toast(`+${fmtMoney(amt)} eklendi`, "good");
  } catch (e) {
    toast("Commit hatası: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Nakiti Ekle";
  }
}

async function submitBuy() {
  const tk = (document.getElementById("buy-ticker").value || "").trim().toUpperCase();
  const shares = parseFloat(document.getElementById("buy-shares").value);
  const price = parseFloat(document.getElementById("buy-price").value);
  const date = document.getElementById("buy-date").value || todayIso();
  if (!tk || !shares || !price) { toast("Tüm alanları doldur", "bad"); return; }
  if (!getToken()) { showTokenSetup(true); toast("Önce token ekle", "bad"); return; }
  const amount = shares * price;

  // Update positions
  const newPositions = [...state.positions];
  const existing = newPositions.find(p => p.ticker === tk);
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
      first_buy_date: date, sector,
    });
  }

  const newTxns = [...state.transactions, {
    date, action: "BUY", ticker: tk, shares, price, amount,
  }];
  const newCash = { ...state.cash, cash: (state.cash.cash || 0) - amount };

  const tmpState = { ...state, positions: newPositions, transactions: newTxns, cash: newCash };
  const posCsv = csvStringify(
    tmpState.positions.map(p => ({
      ticker: p.ticker,
      shares: p.shares.toFixed(6).replace(/\.?0+$/, ""),
      cost_basis: p.cost_basis.toFixed(2),
      first_buy_date: p.first_buy_date,
      sector: p.sector,
    })),
    ["ticker", "shares", "cost_basis", "first_buy_date", "sector"]
  );
  const txnsCsv = csvStringify(
    tmpState.transactions.map(t => ({
      date: t.date, action: t.action, ticker: t.ticker || "",
      shares: t.shares ? t.shares.toFixed(6).replace(/\.?0+$/, "") : "0",
      price: t.price ? t.price.toFixed(4).replace(/\.?0+$/, "") : "0",
      amount: (t.amount || 0).toFixed(2),
    })),
    ["date", "action", "ticker", "shares", "price", "amount"]
  );

  const btn = document.getElementById("buy-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
      "cash.json": JSON.stringify(newCash, null, 2) + "\n",
    }, `BUY ${tk}: ${shares} @ $${price} on ${date}`);
    state.positions = newPositions;
    state.transactions = newTxns;
    state.cash = newCash;
    document.getElementById("buy-shares").value = "";
    document.getElementById("buy-price").value = "";
    document.getElementById("buy-ticker").value = "";
    delete document.getElementById("buy-ticker").dataset.selectedTicker;
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    updateBuySummary();
    toast(`BUY ${tk}: ${shares} × ${fmtMoney(price)} = ${fmtMoney(amount)}`, "good");
  } catch (e) {
    toast("Commit hatası: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Alımı Kaydet";
  }
}

async function submitSell() {
  const tk = document.getElementById("sell-ticker").value;
  const shares = parseFloat(document.getElementById("sell-shares").value);
  const price = parseFloat(document.getElementById("sell-price").value);
  const date = document.getElementById("sell-date").value || todayIso();
  if (!tk || !shares || !price) { toast("Tüm alanları doldur", "bad"); return; }
  if (!getToken()) { showTokenSetup(true); toast("Önce token ekle", "bad"); return; }

  const pos = state.positions.find(p => p.ticker === tk);
  if (!pos || pos.shares < shares) { toast("Yetersiz pozisyon", "bad"); return; }

  const proceeds = shares * price;
  const cost_per_share = pos.cost_basis / pos.shares;
  const cost_removed = cost_per_share * shares;

  const newPositions = state.positions
    .map(p => {
      if (p.ticker !== tk) return p;
      const remaining_shares = p.shares - shares;
      if (remaining_shares < 1e-6) return null; // delete fully closed
      return { ...p, shares: remaining_shares, cost_basis: p.cost_basis - cost_removed };
    })
    .filter(Boolean);

  const newTxns = [...state.transactions, {
    date, action: "SELL", ticker: tk, shares, price, amount: proceeds,
  }];
  const newCash = { ...state.cash, cash: (state.cash.cash || 0) + proceeds };

  const tmpState = { ...state, positions: newPositions, transactions: newTxns, cash: newCash };
  const posCsv = csvStringify(
    tmpState.positions.map(p => ({
      ticker: p.ticker,
      shares: p.shares.toFixed(6).replace(/\.?0+$/, ""),
      cost_basis: p.cost_basis.toFixed(2),
      first_buy_date: p.first_buy_date,
      sector: p.sector,
    })),
    ["ticker", "shares", "cost_basis", "first_buy_date", "sector"]
  );
  const txnsCsv = csvStringify(
    tmpState.transactions.map(t => ({
      date: t.date, action: t.action, ticker: t.ticker || "",
      shares: t.shares ? t.shares.toFixed(6).replace(/\.?0+$/, "") : "0",
      price: t.price ? t.price.toFixed(4).replace(/\.?0+$/, "") : "0",
      amount: (t.amount || 0).toFixed(2),
    })),
    ["date", "action", "ticker", "shares", "price", "amount"]
  );

  const btn = document.getElementById("sell-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
      "cash.json": JSON.stringify(newCash, null, 2) + "\n",
    }, `SELL ${tk}: ${shares} @ $${price} on ${date}`);
    state.positions = newPositions;
    state.transactions = newTxns;
    state.cash = newCash;
    document.getElementById("sell-shares").value = "";
    document.getElementById("sell-price").value = "";
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    updateSellSummary();
    toast(`SELL ${tk}: ${shares} × ${fmtMoney(price)} = ${fmtMoney(proceeds)}`, "good");
  } catch (e) {
    toast("Commit hatası: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Satışı Kaydet";
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

function parseImportCsv(text) {
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
    // Normalize date: try YYYY-MM-DD, DD/MM/YYYY, etc.
    date = date.split("T")[0].replace(/[./]/g, "-");
    if (/^\d{2}-\d{2}-\d{4}$/.test(date)) {
      // Assume DD-MM-YYYY
      const [d, m, y] = date.split("-");
      date = `${y}-${m}-${d}`;
    }
    out.push({
      date, action: isBuy ? "BUY" : "SELL",
      ticker, shares, price, amount: shares * price,
    });
  }
  return out;
}

function previewCsv(rows) {
  const div = document.getElementById("csv-preview");
  if (!rows || rows.length === 0) {
    div.innerHTML = '<p class="muted">İşlenebilir satır bulunamadı.</p>';
    document.getElementById("csv-submit").classList.add("hidden");
    return;
  }
  div.innerHTML = '<div class="preview-row header"><div>Date</div><div>Action</div><div>Ticker</div><div>Shares</div><div>Price</div><div>Amount</div></div>';
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
  if (!getToken()) { showTokenSetup(true); toast("Önce token ekle", "bad"); return; }

  const newPositions = [...state.positions];
  const newTxns = [...state.transactions];
  let newCash = { ...state.cash };

  for (const r of state.pendingCsvRows) {
    if (r.action === "BUY") {
      const existing = newPositions.find(p => p.ticker === r.ticker);
      const sector = (state.tickerIndex.find(x => x.t === r.ticker) || {}).s
                     || (existing ? existing.sector : "Other");
      if (existing) {
        existing.shares += r.shares;
        existing.cost_basis += r.amount;
        if (!existing.first_buy_date) existing.first_buy_date = r.date;
      } else {
        newPositions.push({
          ticker: r.ticker, shares: r.shares, cost_basis: r.amount,
          first_buy_date: r.date, sector,
        });
      }
      newCash.cash -= r.amount;
      newTxns.push(r);
    } else if (r.action === "SELL") {
      const idx = newPositions.findIndex(p => p.ticker === r.ticker);
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
      newCash.cash += r.amount;
      newTxns.push(r);
    }
  }

  const posCsv = csvStringify(
    newPositions.map(p => ({
      ticker: p.ticker,
      shares: p.shares.toFixed(6).replace(/\.?0+$/, ""),
      cost_basis: p.cost_basis.toFixed(2),
      first_buy_date: p.first_buy_date,
      sector: p.sector,
    })),
    ["ticker", "shares", "cost_basis", "first_buy_date", "sector"]
  );
  const txnsCsv = csvStringify(
    newTxns.map(t => ({
      date: t.date, action: t.action, ticker: t.ticker || "",
      shares: t.shares ? t.shares.toFixed(6).replace(/\.?0+$/, "") : "0",
      price: t.price ? t.price.toFixed(4).replace(/\.?0+$/, "") : "0",
      amount: (t.amount || 0).toFixed(2),
    })),
    ["date", "action", "ticker", "shares", "price", "amount"]
  );

  const btn = document.getElementById("csv-submit");
  btn.disabled = true; btn.textContent = "Commit...";
  try {
    await ghCommitMultiFile({
      "positions.csv": posCsv,
      "transactions.csv": txnsCsv,
      "cash.json": JSON.stringify(newCash, null, 2) + "\n",
    }, `CSV import: ${state.pendingCsvRows.length} transactions`);
    state.positions = newPositions;
    state.transactions = newTxns;
    state.cash = newCash;
    state.pendingCsvRows = null;
    document.getElementById("csv-preview").innerHTML = "";
    document.getElementById("csv-file").value = "";
    btn.classList.add("hidden");
    renderPortfolio();
    renderTransactions();
    refreshSellDropdown();
    toast(`${state.pendingCsvRows ? state.pendingCsvRows.length : "?"} işlem commit edildi`, "good");
  } catch (e) {
    toast("Commit hatası: " + e.message, "bad");
  } finally {
    btn.disabled = false; btn.textContent = "Onayla ve Commit Et";
  }
}

// ---------- Bootstrap ----------
async function init() {
  setupTabs();
  setupTickerSearch();
  await loadTickerIndex();

  if (!getToken()) {
    showTokenSetup(true);
    document.getElementById("status").textContent = "Token bekleniyor (private repo)";
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
    toast("Token kaydedildi, veri çekiliyor...", "good");
    await loadState();
  });
  document.getElementById("logout-btn").addEventListener("click", () => {
    clearToken();
    showTokenSetup(true);
    toast("Token silindi");
  });
  document.getElementById("refresh-btn").addEventListener("click", loadState);

  document.getElementById("cash-submit").addEventListener("click", submitCash);
  document.getElementById("buy-submit").addEventListener("click", submitBuy);
  document.getElementById("sell-submit").addEventListener("click", submitSell);
  document.getElementById("csv-submit").addEventListener("click", commitCsvImport);

  ["buy-shares", "buy-price"].forEach(id =>
    document.getElementById(id).addEventListener("input", updateBuySummary));
  ["sell-ticker", "sell-shares", "sell-price"].forEach(id =>
    document.getElementById(id).addEventListener("input", updateSellSummary));
  document.getElementById("sell-ticker").addEventListener("change", updateSellSummary);

  document.getElementById("csv-file").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const text = await f.text();
    state.pendingCsvRows = parseImportCsv(text);
    previewCsv(state.pendingCsvRows);
  });

  // Default dates to today
  const today = todayIso();
  ["cash-date", "buy-date", "sell-date"].forEach(id => document.getElementById(id).value = today);
}

init();
