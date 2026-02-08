/* global A1lib, Chatbox, alt1 */

A1lib.identifyApp("appconfig.json");

// -------------------------
// Config
// -------------------------
const SAVE_KEY = "snapshot";
const STORAGE_VERSION = 1;

const FEED_LINE = "The dog happily eats the treat.";
const FIND_REGEX = /^You find\s+(\d+)\s+(.+?)\.\s*$/i;
const TIMESTAMP_REGEX = /\[\d{2}:\d{2}:\d{2}\]/g;

const DOG_IMAGE = "./assests/dog.png";

// Food manifest (Alt1 supports relative fetch; browser file:// may fail)
const FOOD_DIR = "./assests/food/";
const FOOD_MANIFEST = "./assests/manifest.json";

// Debug
const DEBUG = true; // set false before release

// Deduping
let chatInitialized = false;
const chatSeen = new Set();
const chatSeenQueue = [];
const CHAT_SEEN_MAX = 250;

// Expand rows
const expandedRows = new Set();

// -------------------------
// Drops
// -------------------------
const DROPS = [
  { id: "coins", name: "Coins", min: 500, max: 727, icon: "./assests/coins_250.png" },
  { id: "bones", name: "Bones", min: 1, max: 5, icon: "./assests/bones.png" },
  { id: "big_bones", name: "Big bones", min: 1, max: 5, icon: "./assests/big_bones.png" },
  { id: "grimy_tarromin", name: "Grimy tarromin", min: 1, max: 3, icon: "./assests/grimy_tarromin.png" },
  { id: "grimy_guam", name: "Grimy guam", min: 1, max: 3, icon: "./assests/grimy_guam.png" },
  { id: "oak_logs", name: "Oak logs", min: 1, max: 5, icon: "./assests/oak_logs.png" },
  { id: "battlestaff", name: "Battlestaff", min: 1, max: 1, icon: "./assests/battlestaff.png" },
  { id: "gold_ring", name: "Gold ring", min: 1, max: 2, icon: "./assests/gold_ring.png" },
  { id: "leather_boots", name: "Leather boots", min: 1, max: 2, icon: "./assests/leather_boots.png" },
  { id: "gnomeball", name: "Gnomeball", min: 1, max: 1, icon: "./assests/gnomeball.png" },
  { id: "silvery_feather", name: "Silvery feather", min: 1, max: 1, icon: "./assests/silvery_feather.png" },
];

const ITEM_NAME_TO_ID = Object.fromEntries(DROPS.map(d => [d.name.toLowerCase(), d.id]));

// -------------------------
// Food list (loaded)
// -------------------------
let FOOD_IMAGES = [];

// -------------------------
// Alt1
// -------------------------
let reader = new Chatbox.default();
let chatInterval = null;

// -------------------------
// Debug UI
// -------------------------
let debugBuffer = [];

function dbg(msg) {
  if (!DEBUG) return;
  const ts = new Date().toLocaleTimeString();
  debugBuffer.push(`[${ts}] ${msg}`);
  if (debugBuffer.length > 300) debugBuffer.shift();

  const pre = document.getElementById("debugLog");
  if (pre) pre.textContent = debugBuffer.join("\n");

  console.log("[DBG]", msg);
}

function setupDebugUI() {
  const showBtn = document.getElementById("showDebugBtn");
  const hideBtn = document.getElementById("debugToggleBtn");
  const card = document.getElementById("debugCard");

  if (!showBtn || !hideBtn || !card) return;

  showBtn.onclick = () => {
    card.style.display = "block";
    showBtn.style.display = "none";
  };

  hideBtn.onclick = () => {
    card.style.display = "none";
    showBtn.style.display = "inline-block";
  };
}

// -------------------------
// State
// -------------------------
let state;

function defaultState() {
  return {
    version: STORAGE_VERSION,
    feedCount: 0,
    totalRolls: 0,
    foodWasted: 0,
    lastRollTime: null,
    rollIntervals: [],
    drops: Object.fromEntries(
      DROPS.map(d => [
        d.id,
        {
          count: 0,
          qtySum: 0,
          qtyCounts: {},
          observedMin: null,
          observedMax: null
        }
      ])
    )
  };
}

function saveState() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(state)); } catch {}
}

function loadState() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) {
      state = defaultState();
      return;
    }

    const parsed = JSON.parse(raw);
    if (!parsed || parsed.version !== STORAGE_VERSION) {
      state = defaultState();
      return;
    }

    state = parsed;

    // normalize
    state.feedCount = Number(state.feedCount || 0);
    state.totalRolls = Number(state.totalRolls || 0);
    state.foodWasted = Number(state.foodWasted || 0);
    state.lastRollTime = state.lastRollTime ?? null;
    state.rollIntervals = Array.isArray(state.rollIntervals) ? state.rollIntervals : [];

    state.drops = state.drops || {};
    for (const d of DROPS) {
      if (!state.drops[d.id]) {
        state.drops[d.id] = { count: 0, qtySum: 0, qtyCounts: {}, observedMin: null, observedMax: null };
      }
      const o = state.drops[d.id];
      o.count = Number(o.count || 0);
      o.qtySum = Number(o.qtySum || 0);
      o.qtyCounts = o.qtyCounts || {};
      o.observedMin = (o.observedMin ?? null);
      o.observedMax = (o.observedMax ?? null);
    }
  } catch {
    state = defaultState();
  }
}

function resetCounters() {
  state = defaultState();
  expandedRows.clear();
  updateDisplay();
  saveState();
}

// -------------------------
// Food manifest
// -------------------------
function loadFoodManifest() {
  fetch(FOOD_MANIFEST)
    .then(r => r.json())
    .then(list => {
      if (Array.isArray(list)) {
        FOOD_IMAGES = list.map(f => FOOD_DIR + f);
        dbg(`Loaded food images: ${FOOD_IMAGES.length}`);
      }
    })
    .catch(err => {
      dbg(`Food manifest failed, fallback used: ${String(err)}`);
      FOOD_IMAGES = [FOOD_DIR + "Bacon.png"];
    });
}

// -------------------------
// UI helpers
// -------------------------
function setStatus(text) {
  const el = document.getElementById("appStatus");
  if (el) el.textContent = text;
}

function setDogVisible(visible) {
  const img = document.getElementById("dogPic");
  if (!img) return;
  img.src = DOG_IMAGE;
  img.style.display = visible ? "block" : "none";
}

function avgQty(dropDef) {
  const o = state.drops[dropDef.id];
  return o.count > 0 ? (o.qtySum / o.count).toFixed(2) : "—";
}

function rangeLabel(dropDef) {
  const o = state.drops[dropDef.id];
  if (!o || o.observedMin === null || o.observedMax === null) return "";
  return `range: MIN ${o.observedMin} – MAX ${o.observedMax}`;
}

function avgRollTime() {
  if (!state.rollIntervals.length) return null;
  return state.rollIntervals.reduce((a, b) => a + b, 0) / state.rollIntervals.length;
}

function rollsPerHour() {
  const avg = avgRollTime();
  return avg ? 3600 / avg : null;
}

// -------------------------
// Table rendering
// -------------------------
function renderQtyBreakdownHtml(dropDef) {
  const o = state.drops[dropDef.id];
  const total = o.count || 0;

  // Use observed range (when present) so new max values appear
  const minQ = o.observedMin ?? dropDef.min;
  const maxQ = o.observedMax ?? dropDef.max;

  const parts = [];

  // Guard against huge ranges (coins) even if observed explodes
  const span = maxQ - minQ;
  if (span > 25) {
    return `<div class="muted">Range too large to display.</div>`;
  }

  for (let q = minQ; q <= maxQ; q++) {
    const c = Number(o.qtyCounts?.[q] || 0);
    if (c === 0) continue;

    const pct = total ? ((c / total) * 100).toFixed(1) : "0.0";
    parts.push(`
      <div class="badgeQty">
        <div><span class="k">Qty</span> <span class="v">${q}</span></div>
        <div><span class="k">Count</span> <span class="v">${c}</span></div>
        <div><span class="k">%</span> <span class="v">${pct}%</span></div>
      </div>
    `);
  }

  if (!parts.length) return `<div class="muted">No quantity data yet.</div>`;
  return `<div class="subgrid">${parts.join("")}</div>`;
}

function renderTable() {
  const tbody = document.getElementById("dropsTbody");
  if (!tbody) return;
  tbody.innerHTML = "";

  for (const d of DROPS) {
    const o = state.drops[d.id];
    const chance = state.totalRolls ? ((o.count / state.totalRolls) * 100).toFixed(3) + "%" : "—";
    const avg = avgQty(d);

    // Expand only if variable qty AND we've seen at least 1 qty
    const isExpandable = (d.min !== d.max) && Object.keys(o.qtyCounts || {}).length > 0;
    const isOpen = expandedRows.has(d.id);
    const caret = isExpandable ? (isOpen ? "▾" : "▸") : "";
    const range = rangeLabel(d);

    const tr = document.createElement("tr");
    if (isExpandable) tr.classList.add("row-toggle");

    tr.innerHTML = `
      <td>
        <span class="caret">${caret}</span>
        <img class="drop-icon" src="${d.icon}" onerror="this.style.display='none'">
        <div style="display:inline-block; vertical-align:middle;">
          <div><strong>${d.name}</strong></div>
          ${range ? `<div class="muted" style="font-size:12px; line-height:1.1;">${range}</div>` : ``}
        </div>
      </td>
      <td class="mono">${o.count}</td>
      <td class="mono">${chance}</td>
      <td class="mono">${avg}</td>
    `;

    if (isExpandable) {
      tr.addEventListener("click", () => {
        if (expandedRows.has(d.id)) expandedRows.delete(d.id);
        else expandedRows.add(d.id);
        renderTable();
      });
    }

    tbody.appendChild(tr);

    if (isExpandable && isOpen) {
      const sub = document.createElement("tr");
      sub.className = "subrow";
      sub.innerHTML = `<td colspan="4">${renderQtyBreakdownHtml(d)}</td>`;
      tbody.appendChild(sub);
    }
  }
}

function updateDisplay() {
  const fp = document.getElementById("statFeedProgress");
  const tr = document.getElementById("statTotalRolls");
  const fw = document.getElementById("statFoodWasted");
  const art = document.getElementById("statAvgRollTime");
  const rphEl = document.getElementById("statRollsPerHour");

  if (fp) fp.textContent = `${state.feedCount}/5`;
  if (tr) tr.textContent = String(state.totalRolls);
  if (fw) fw.textContent = String(state.foodWasted);

  const avg = avgRollTime();
  if (art) art.textContent = avg ? avg.toFixed(1) + "s" : "—";

  const rph = rollsPerHour();
  if (rphEl) rphEl.textContent = rph ? rph.toFixed(1) : "—";

  renderTable();
  saveState();
}

// -------------------------
// Parsing helpers
// -------------------------
function normalizeChatKey(line) {
  const tsMatch = line.match(TIMESTAMP_REGEX);
  const ts = tsMatch ? tsMatch[0] : "";
  const msg = line
    .replace(TIMESTAMP_REGEX, "")
    .replace(/\s+/g, " ")
    .trim();
  return ts + "|" + msg;
}

function rememberLine(key) {
  if (chatSeen.has(key)) return;
  chatSeen.add(key);
  chatSeenQueue.push(key);

  while (chatSeenQueue.length > CHAT_SEEN_MAX) {
    const old = chatSeenQueue.shift();
    chatSeen.delete(old);
  }
}

// -------------------------
// Handle parsed line
// -------------------------
function handleLine(line) {
  const clean = line.replace(TIMESTAMP_REGEX, "").trim();

  // Ignore common OCR noise
  if (!clean || clean === "❆") return;

  // Feed
  if (clean.includes(FEED_LINE)) {
    state.feedCount += 1;
    updateDisplay();
    spawnFood();
    return;
  }

  // Loot / roll
  const m = clean.match(FIND_REGEX);
  if (!m) return;

  const qty = Number(m[1]);
  const itemName = m[2].trim().toLowerCase();
  const id = ITEM_NAME_TO_ID[itemName];
  if (!id) return;

  // wasted food is only determined at roll time
  state.foodWasted += Math.max(0, state.feedCount - 5);

  // roll interval timing
  const now = Date.now();
  if (state.lastRollTime !== null) {
    state.rollIntervals.push((now - state.lastRollTime) / 1000);
  }
  state.lastRollTime = now;

  // update drop stats
  const o = state.drops[id];
  o.count += 1;
  o.qtySum += qty;

  // histogram
  o.qtyCounts[qty] = (o.qtyCounts[qty] || 0) + 1;

  // observed min/max
  if (o.observedMin === null || qty < o.observedMin) o.observedMin = qty;
  if (o.observedMax === null || qty > o.observedMax) o.observedMax = qty;

  // reset feed progress after roll
  state.totalRolls += 1;
  state.feedCount = 0;

  updateDisplay();
}

// -------------------------
// Read chatbox (NEW lines only)
// -------------------------
function readChatbox() {
  const opts = reader.read() || [];
  if (!opts.length) return;

  let chatStr = "";

  for (let i in opts) {
    const t = opts[i].text;

    // skip possible continuation line at top without timestamp
    if (!t.match(TIMESTAMP_REGEX) && i == 0) continue;

    // timestamp starts a new reconstructed line
    if (t.match(TIMESTAMP_REGEX)) {
      if (i > 0) chatStr += "\n";
      chatStr += t + " ";
      continue;
    }

    chatStr += t;
  }

  const rawLines = chatStr.trim() ? chatStr.trim().split("\n") : [];
  const tsLines = rawLines.map(l => l.trim()).filter(l => TIMESTAMP_REGEX.test(l));

  if (DEBUG) dbg(`readChatbox: chunks=${opts.length} tsLines=${tsLines.length}`);

  // first read = baseline only
  if (!chatInitialized) {
    tsLines.forEach(l => rememberLine(normalizeChatKey(l)));
    chatInitialized = true;
    if (DEBUG) dbg("Baseline init: stored current lines (no processing)");
    return;
  }

  // process only new
  for (const line of tsLines) {
    const key = normalizeChatKey(line);
    if (chatSeen.has(key)) continue;

    rememberLine(key);
    handleLine(line);
  }
}

// -------------------------
// Food animation (simple)
// -------------------------
function spawnFood() {
  if (!FOOD_IMAGES.length) return;

  const lane = document.getElementById("foodLane");
  if (!lane) return;

  const img = document.createElement("img");
  img.className = "food";
  img.src = FOOD_IMAGES[Math.floor(Math.random() * FOOD_IMAGES.length)];
  lane.appendChild(img);

  // Start just outside the right edge of the lane
  let x = lane.clientWidth + 48;

  // Target is slightly left of the lane start (into the dog side)
  const targetX = -48;

  function tick() {
    x -= 3; // speed (bigger = faster)
    img.style.left = x + "px";

    if (x <= targetX) {
      img.remove(); // eaten
      return;
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
}

// -------------------------
// Init Alt1
// -------------------------
function initAlt1() {
  setStatus("Searching for chatbox…");

  reader.readargs = {
    colors: [
      A1lib.mixColor(255, 255, 255),
      A1lib.mixColor(0, 255, 0),
      A1lib.mixColor(30, 255, 0),
      A1lib.mixColor(30, 255, 0),
    ],
    backwards: true,
  };

  reader.find();

  const find = setInterval(() => {
    if (!reader.pos) return reader.find();

    clearInterval(find);
    reader.pos.mainbox = reader.pos.boxes[0];

    setStatus("Ready. Reading chat…");
    setDogVisible(true);

    chatInterval = setInterval(readChatbox, 200);
  }, 1000);
}

// -------------------------
// Boot
// -------------------------
window.addEventListener("DOMContentLoaded", () => {
  setupDebugUI();
  loadFoodManifest();

  loadState();
  updateDisplay();

  const resetBtn = document.getElementById("resetBtn");
  if (resetBtn) resetBtn.onclick = resetCounters;

  if (window.alt1) initAlt1();
  else setStatus("Browser mode (Alt1 not detected).");
});
