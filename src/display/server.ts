import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import http from "http";
import { GameEvent, TickerEntry } from "../lib/types.js";
import { getAllAgents, getRecentEvents, getRecentTickerEntries, getTickerStats, getCurrentTick, getGameStatus } from "../lib/db.js";
import { getAssetBalance, getExplorerTxUrl, getExplorerAccountUrl } from "../lib/stellar.js";
import { onGameEvent } from "../orchestrator/tick.js";
import { onTickerUpdate } from "../lib/mpp-client.js";

const PORT = process.env.DISPLAY_PORT || 3001;

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Track connected clients
const clients = new Set<WebSocket>();

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log("Display client connected");

  // Send initial state
  sendFullState(ws);

  ws.on("close", () => {
    clients.delete(ws);
    console.log("Display client disconnected");
  });
});

function broadcast(message: object): void {
  const data = JSON.stringify(message);
  for (const client of clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(data);
    }
  }
}

async function sendFullState(ws: WebSocket): Promise<void> {
  const agents = getAllAgents();
  const agentsWithBalances = await Promise.all(
    agents.map(async (agent) => ({
      ...agent,
      balance: await getAssetBalance(agent.publicKey),
      explorerUrl: getExplorerAccountUrl(agent.publicKey),
    }))
  );

  const tickerStats = getTickerStats();

  ws.send(JSON.stringify({
    type: "full_state",
    data: {
      status: getGameStatus(),
      tick: getCurrentTick(),
      tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS || "300000", 10),
      maxTicks: parseInt(process.env.MAX_TICKS || "48", 10),
      agents: agentsWithBalances.map((a) => ({
        id: a.id,
        name: a.name,
        title: a.title,
        prestige: a.prestige,
        balance: a.balance,
        statusEffects: a.statusEffects,
        allies: a.allies,
        explorerUrl: a.explorerUrl,
      })),
      recentEvents: getRecentEvents(20),
      ticker: getRecentTickerEntries(15),
      stats: {
        totalTransactions: tickerStats.total,
        totalAmountMoved: tickerStats.amountMoved,
        avgSettlementTime: tickerStats.avgSettlement,
      },
    },
  }));
}

// Subscribe to game events
onGameEvent((event: GameEvent) => {
  broadcast({
    type: "game_event",
    data: event,
  });
});

// Subscribe to ticker updates
onTickerUpdate((entry: TickerEntry) => {
  broadcast({
    type: "ticker_update",
    data: {
      ...entry,
      explorerUrl: entry.txHash ? getExplorerTxUrl(entry.txHash) : undefined,
    },
  });
});

// Serve the display HTML
app.get("/", (req, res) => {
  res.send(DISPLAY_HTML);
});

// API endpoints for polling (fallback)
app.get("/api/state", async (req, res) => {
  const agents = getAllAgents();
  const agentsWithBalances = await Promise.all(
    agents.map(async (agent) => ({
      id: agent.id,
      name: agent.name,
      title: agent.title,
      prestige: agent.prestige,
      balance: await getAssetBalance(agent.publicKey),
      statusEffects: agent.statusEffects,
      allies: agent.allies,
    }))
  );

  res.json({
    status: getGameStatus(),
    tick: getCurrentTick(),
    tickIntervalMs: parseInt(process.env.TICK_INTERVAL_MS || "300000", 10),
    maxTicks: parseInt(process.env.MAX_TICKS || "48", 10),
    agents: agentsWithBalances,
    recentEvents: getRecentEvents(20),
    ticker: getRecentTickerEntries(15),
    stats: getTickerStats(),
  });
});

export function startDisplayServer(): void {
  server.listen(PORT, () => {
    console.log(`Display server running on http://localhost:${PORT}`);
  });
}

// HTML for the display page — full-fat corporate-dashboard parody.
const DISPLAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MegaCorp · Q1 FY2026 Performance Dashboard</title>
  <style>
    /* ====================================================================
       MegaCorp Q1 FY2026 Performance Dashboard
       Theme: drab-realistic corporate intranet, c. 2007.
       ==================================================================== */

    * { margin: 0; padding: 0; box-sizing: border-box; }

    :root {
      --navy:        #1c3a64;
      --navy-2:      #2c5896;
      --navy-text:   #ffffff;
      --bg:          #f4f6fa;
      --panel:       #ffffff;
      --panel-head:  #dce9f5;
      --panel-head-text: #1c3a64;
      --border:      #c8d6e5;
      --border-2:    #aab9c9;
      --text:        #2c3e50;
      --text-muted:  #7a8b99;
      --text-faint:  #9aaab8;

      --success:     #27ae60;
      --success-bg:  #d4f4dd;
      --warning:     #d68910;
      --warning-bg:  #fef5e7;
      --danger:      #c0392b;
      --danger-bg:   #fadbd8;
      --info:        #2471a3;
      --info-bg:     #d6eaf8;
      --neutral-bg:  #ecf0f1;

      --shadow:      0 1px 2px rgba(28, 58, 100, 0.06), 0 1px 4px rgba(28, 58, 100, 0.05);
    }

    html, body {
      font-family: Calibri, "Segoe UI", Arial, sans-serif;
      font-size: 13px;
      color: var(--text);
      background: var(--bg);
      min-height: 100vh;
      line-height: 1.4;
    }

    a { color: var(--info); }
    a:hover { color: var(--navy); }

    /* === Header banner ============================================== */
    .exec-banner {
      background: linear-gradient(180deg, var(--navy) 0%, var(--navy-2) 100%);
      color: var(--navy-text);
      padding: 10px 24px;
      display: grid;
      grid-template-columns: auto 1fr auto;
      gap: 20px;
      align-items: center;
      border-bottom: 3px solid #f1c40f;
      transition: background 0.6s ease;
    }
    .exec-banner.tick-pulse { animation: tickHeader 1.4s ease-out; }
    @keyframes tickHeader {
      0% { background: linear-gradient(180deg, var(--navy) 0%, var(--navy-2) 100%); }
      30% { background: linear-gradient(180deg, #2c5896 0%, #4575b3 100%); }
      100% { background: linear-gradient(180deg, var(--navy) 0%, var(--navy-2) 100%); }
    }

    .brand {
      display: flex;
      flex-direction: column;
    }
    .brand-mark {
      font-size: 18px;
      font-weight: 700;
      letter-spacing: 0.5px;
    }
    .brand-mark::before {
      content: "▸ ";
      color: #f1c40f;
    }
    .brand-tagline {
      font-size: 11px;
      color: rgba(255,255,255,0.75);
      text-transform: uppercase;
      letter-spacing: 1px;
    }

    .doc-title {
      text-align: center;
      font-size: 14px;
      font-weight: 600;
      letter-spacing: 0.4px;
    }
    .doc-classification {
      font-size: 10px;
      color: rgba(255,255,255,0.7);
      text-transform: uppercase;
      letter-spacing: 1.5px;
      text-align: center;
    }

    .header-meta {
      display: flex;
      gap: 16px;
      align-items: center;
    }
    .meta-item {
      background: rgba(255,255,255,0.10);
      padding: 6px 12px;
      border-radius: 3px;
      border: 1px solid rgba(255,255,255,0.15);
      min-width: 110px;
    }
    .meta-label {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: rgba(255,255,255,0.65);
      display: block;
    }
    .meta-value {
      font-size: 14px;
      font-weight: 600;
      font-variant-numeric: tabular-nums;
    }
    .meta-item.countdown .meta-value {
      color: #f1c40f;
    }
    .meta-item.countdown .meta-value.tick { animation: countdownTick 1s ease-out; }
    @keyframes countdownTick {
      0% { transform: scale(1.05); color: #ffffff; }
      100% { transform: scale(1.00); color: #f1c40f; }
    }

    /* === KPI strip ================================================== */
    .kpi-strip {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 12px;
      padding: 14px 24px;
      background: var(--bg);
    }
    .kpi-tile {
      background: var(--panel);
      border: 1px solid var(--border);
      border-top: 3px solid var(--navy);
      box-shadow: var(--shadow);
      padding: 12px 14px;
    }
    .kpi-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 1px;
      color: var(--text-muted);
      font-weight: 600;
    }
    .kpi-sublabel {
      font-size: 11px;
      color: var(--text-faint);
      margin-bottom: 6px;
    }
    .kpi-value {
      font-size: 24px;
      font-weight: 700;
      color: var(--navy);
      font-variant-numeric: tabular-nums;
    }
    .kpi-suffix {
      font-size: 12px;
      color: var(--text-muted);
      font-weight: 400;
      margin-left: 4px;
    }
    .kpi-tile.value-bumped .kpi-value { animation: kpiBump 0.5s ease-out; }
    @keyframes kpiBump {
      0% { transform: scale(1); color: var(--navy); }
      30% { transform: scale(1.06); color: var(--success); }
      100% { transform: scale(1); color: var(--navy); }
    }

    /* === Main two-column grid ======================================= */
    .dash-grid {
      display: grid;
      grid-template-columns: minmax(420px, 38%) 1fr;
      gap: 14px;
      padding: 0 24px 14px 24px;
    }

    .panel {
      background: var(--panel);
      border: 1px solid var(--border);
      box-shadow: var(--shadow);
      display: flex;
      flex-direction: column;
      min-height: 0;
    }
    .panel-head {
      background: var(--panel-head);
      color: var(--panel-head-text);
      padding: 8px 14px;
      border-bottom: 1px solid var(--border);
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.6px;
    }
    .panel-head .panel-meta {
      font-size: 10px;
      font-weight: 400;
      color: var(--text-muted);
      letter-spacing: 0.4px;
      text-transform: none;
    }

    /* === Leaderboard ================================================ */
    .leaderboard {
      overflow-y: auto;
      max-height: calc(100vh - 280px);
    }
    .manager-row {
      display: grid;
      grid-template-columns: 30px 1fr auto;
      gap: 10px;
      padding: 10px 14px;
      border-bottom: 1px solid var(--border);
      align-items: center;
      cursor: pointer;
      transition: background 0.12s, transform 0.45s ease;
    }
    .manager-row:hover { background: var(--info-bg); }
    .manager-row .rank {
      font-size: 16px;
      font-weight: 700;
      color: var(--text-muted);
      text-align: center;
    }
    .manager-row.rank-1 .rank { color: #d4ac0d; }
    .manager-row.rank-2 .rank { color: #707b7c; }
    .manager-row.rank-3 .rank { color: #b9770e; }

    .manager-identity .name {
      font-weight: 600;
      color: var(--text);
      font-size: 13px;
    }
    .manager-identity .title {
      font-size: 11px;
      color: var(--text-muted);
    }
    .manager-identity .traits {
      font-size: 10px;
      color: var(--text-faint);
      letter-spacing: 0.3px;
      margin-top: 2px;
      font-family: "Consolas", "Menlo", monospace;
    }
    .manager-identity .badges {
      display: flex;
      gap: 4px;
      margin-top: 4px;
      flex-wrap: wrap;
    }
    .badge {
      font-size: 9px;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      padding: 2px 6px;
      border-radius: 2px;
      font-weight: 600;
      border: 1px solid currentColor;
    }
    .badge.tired { color: var(--text-muted); background: var(--neutral-bg); }
    .badge.caffeinated { color: var(--info); background: var(--info-bg); }
    .badge.inspired { color: var(--success); background: var(--success-bg); }
    .badge.under_investigation { color: var(--warning); background: var(--warning-bg); }
    .badge.problematic { color: var(--danger); background: var(--danger-bg); }
    .badge.under_review { color: var(--warning); background: var(--warning-bg); }
    .badge.technical_difficulties { color: var(--danger); background: var(--danger-bg); }
    .badge.has_deliverable { color: var(--success); background: var(--success-bg); }

    .manager-stats {
      text-align: right;
      font-variant-numeric: tabular-nums;
    }
    .manager-stats .prestige {
      font-size: 16px;
      font-weight: 700;
      color: var(--navy);
    }
    .manager-stats .prestige.bumped { animation: prestigeBump 0.6s ease-out; }
    @keyframes prestigeBump {
      0%   { transform: scale(1); color: var(--navy); }
      30%  { transform: scale(1.15); color: var(--success); }
      100% { transform: scale(1); color: var(--navy); }
    }
    .manager-stats .balance {
      font-size: 12px;
      color: var(--text-muted);
    }
    .manager-stats .balance.low { color: var(--danger); font-weight: 600; }

    /* === Activity stream (merged feed) ============================== */
    .stream {
      overflow-y: auto;
      max-height: calc(100vh - 280px);
      padding: 0;
    }
    .feed-entry {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      animation: slideInRight 0.35s ease-out;
      position: relative;
    }
    @keyframes slideInRight {
      from { opacity: 0; transform: translateX(40px); }
      to   { opacity: 1; transform: translateX(0); }
    }

    .feed-entry .feed-head {
      display: flex;
      gap: 10px;
      align-items: baseline;
      font-size: 10px;
      color: var(--text-faint);
      text-transform: uppercase;
      letter-spacing: 0.6px;
      margin-bottom: 4px;
    }
    .feed-entry .feed-head .cycle {
      font-weight: 700;
      color: var(--navy);
    }
    .feed-entry .feed-head .badge-type {
      margin-left: auto;
      padding: 1px 6px;
      border-radius: 2px;
      font-weight: 600;
      letter-spacing: 0.5px;
    }
    .feed-entry .feed-head .badge-type.action { background: var(--neutral-bg); color: var(--text-muted); }
    .feed-entry .feed-head .badge-type.payment { background: var(--success-bg); color: var(--success); }
    .feed-entry .feed-head .badge-type.payment_failed { background: var(--danger-bg); color: var(--danger); }
    .feed-entry .feed-head .badge-type.alliance_formed { background: var(--info-bg); color: var(--info); }
    .feed-entry .feed-head .badge-type.alliance_rejected { background: var(--warning-bg); color: var(--warning); }
    .feed-entry .feed-head .badge-type.alliance_broken { background: var(--danger-bg); color: var(--danger); }
    .feed-entry .feed-head .badge-type.random_event { background: #f4ecf7; color: #8e44ad; }
    .feed-entry .feed-head .badge-type.status_effect { background: var(--neutral-bg); color: var(--text-muted); }

    .feed-action {
      font-size: 13px;
      color: var(--text);
      margin-bottom: 6px;
    }
    .feed-action .actor { font-weight: 600; color: var(--navy); }
    .feed-action .arrow { color: var(--text-faint); margin: 0 4px; }
    .feed-action .recipient { font-weight: 500; }

    .feed-mpp {
      display: flex;
      gap: 14px;
      align-items: center;
      margin: 6px 0;
      padding: 8px 10px;
      background: #f8fafd;
      border: 1px solid var(--border);
      border-radius: 3px;
      font-size: 12px;
      font-variant-numeric: tabular-nums;
    }
    .feed-mpp .amount {
      font-weight: 700;
      font-size: 14px;
      color: var(--navy);
    }
    .feed-mpp .status-badge {
      padding: 2px 8px;
      border-radius: 2px;
      font-size: 10px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    .feed-mpp .status-badge.pending { background: var(--warning-bg); color: var(--warning); animation: blink 1s infinite; }
    .feed-mpp .status-badge.submitted { background: var(--info-bg); color: var(--info); animation: blink 0.8s infinite; }
    .feed-mpp .status-badge.settled { background: var(--success-bg); color: var(--success); }
    .feed-mpp .status-badge.failed { background: var(--danger-bg); color: var(--danger); }
    @keyframes blink {
      50% { opacity: 0.55; }
    }
    .feed-mpp .settlement-time { color: var(--text-muted); font-size: 11px; }
    .feed-mpp .tx-link {
      margin-left: auto;
      font-family: "Consolas", "Menlo", monospace;
      font-size: 11px;
    }
    .feed-mpp .tx-link a { color: var(--info); text-decoration: none; }
    .feed-mpp .tx-link a:hover { text-decoration: underline; }

    .feed-quote {
      margin-top: 6px;
      padding: 6px 10px;
      background: #fff8e1;
      border-left: 3px solid #f1c40f;
      font-style: italic;
      font-size: 12px;
      color: #5d4e07;
      line-height: 1.5;
      white-space: pre-wrap;
    }
    .feed-outcome {
      margin-top: 4px;
      font-size: 12px;
      color: var(--text-muted);
      font-style: italic;
    }
    .feed-error {
      margin-top: 4px;
      font-size: 11px;
      color: var(--danger);
      font-weight: 600;
    }

    .feed-entry.flash-settled { animation: flashSettled 1s ease-out; }
    @keyframes flashSettled {
      0%   { background: var(--success-bg); }
      100% { background: transparent; }
    }
    .feed-entry.flash-failed { animation: flashFailed 1s ease-out; }
    @keyframes flashFailed {
      0%   { background: var(--danger-bg); }
      100% { background: transparent; }
    }
    .feed-entry.linked-hover { background: #fff9d8; }

    /* === Footer ===================================================== */
    .legal-footer {
      padding: 8px 24px;
      background: var(--navy);
      color: rgba(255,255,255,0.65);
      font-size: 10px;
      letter-spacing: 0.5px;
      text-align: center;
      border-top: 1px solid #0d1f3a;
    }
    .legal-footer .stamp {
      color: #f1c40f;
      font-weight: 600;
      letter-spacing: 1px;
    }

    /* === Halted overlay ============================================= */
    .halted-overlay {
      position: fixed;
      inset: 0;
      background: rgba(28, 58, 100, 0.92);
      color: #ffffff;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      z-index: 1000;
    }
    .halted-overlay.hidden { display: none; }
    .halted-overlay .stamp {
      border: 4px solid #f1c40f;
      color: #f1c40f;
      font-size: 36px;
      font-weight: 700;
      letter-spacing: 4px;
      padding: 16px 40px;
      transform: rotate(-3deg);
      text-transform: uppercase;
    }
    .halted-overlay .sub {
      margin-top: 18px;
      color: rgba(255,255,255,0.75);
      letter-spacing: 1px;
    }

    /* === Empty state ================================================ */
    .empty-state {
      padding: 32px;
      text-align: center;
      color: var(--text-faint);
      font-style: italic;
    }
  </style>
</head>
<body>
  <div id="halted-overlay" class="halted-overlay hidden">
    <div class="stamp">Cycle Paused</div>
    <div class="sub">Strategic Review In Progress · State Preserved</div>
  </div>

  <header class="exec-banner" id="banner">
    <div class="brand">
      <div class="brand-mark">MegaCorp Inc.</div>
      <div class="brand-tagline">Synergy &amp; Strategic Operations Division</div>
    </div>
    <div>
      <div class="doc-title">Q1 FY2026 Performance Dashboard</div>
      <div class="doc-classification">Confidential · Internal Distribution Only</div>
    </div>
    <div class="header-meta">
      <div class="meta-item">
        <span class="meta-label">Cycle</span>
        <span class="meta-value" id="cycle">0</span>
      </div>
      <div class="meta-item">
        <span class="meta-label">Status</span>
        <span class="meta-value" id="status">Initializing</span>
      </div>
      <div class="meta-item countdown">
        <span class="meta-label">Next Sync-up</span>
        <span class="meta-value" id="countdown">—</span>
      </div>
    </div>
  </header>

  <section class="kpi-strip">
    <div class="kpi-tile" id="kpi-settlements">
      <div class="kpi-label">Settlements YTD</div>
      <div class="kpi-sublabel">Aggregate Capital Movement</div>
      <div class="kpi-value">$<span id="kpi-amount">0.00</span><span class="kpi-suffix">DLBR</span></div>
    </div>
    <div class="kpi-tile" id="kpi-tx">
      <div class="kpi-label">Transaction Throughput</div>
      <div class="kpi-sublabel">Cleared On-Chain Settlements</div>
      <div class="kpi-value"><span id="kpi-count">0</span><span class="kpi-suffix">tx</span></div>
    </div>
    <div class="kpi-tile" id="kpi-velocity">
      <div class="kpi-label">Operational Velocity</div>
      <div class="kpi-sublabel">Mean Settlement Latency</div>
      <div class="kpi-value"><span id="kpi-velocity-val">0.0</span><span class="kpi-suffix">sec</span></div>
    </div>
    <div class="kpi-tile" id="kpi-roster">
      <div class="kpi-label">Active Headcount</div>
      <div class="kpi-sublabel">Managers In Cycle</div>
      <div class="kpi-value"><span id="kpi-headcount">0</span><span class="kpi-suffix">FTE</span></div>
    </div>
  </section>

  <main class="dash-grid">
    <section class="panel">
      <div class="panel-head">
        <span>Executive Leaderboard</span>
        <span class="panel-meta">Sorted by Prestige · click manager for review</span>
      </div>
      <div class="leaderboard" id="leaderboard">
        <div class="empty-state">No managers reporting yet.</div>
      </div>
    </section>

    <section class="panel">
      <div class="panel-head">
        <span>Manager Activity Stream</span>
        <span class="panel-meta">Live · in-character justifications &amp; on-chain settlement</span>
      </div>
      <div class="stream" id="stream">
        <div class="empty-state">Waiting for the first cycle to begin…</div>
      </div>
    </section>
  </main>

  <footer class="legal-footer">
    <span class="stamp">CONFIDENTIAL</span>
    &nbsp;·&nbsp;
    Strategic Insights Engine v3.2
    &nbsp;·&nbsp;
    Generated by MegaCorp People Analytics &amp; Synergy Division
    &nbsp;·&nbsp;
    Settlement layer: Stellar testnet (DLBR · Deliverabills)
  </footer>

  <script>
    // ============================================================
    // Hover-link: highlight matching pairs of (event, ticker entry)
    // by tx hash.
    // ============================================================
    document.addEventListener('mouseover', (e) => {
      const el = e.target.closest('[data-tx-hash]');
      if (!el) return;
      const hash = el.dataset.txHash;
      document.querySelectorAll('[data-tx-hash="' + hash + '"]').forEach(n => n.classList.add('linked-hover'));
    });
    document.addEventListener('mouseout', (e) => {
      const el = e.target.closest('[data-tx-hash]');
      if (!el) return;
      document.querySelectorAll('.linked-hover').forEach(n => n.classList.remove('linked-hover'));
    });

    // ============================================================
    // State + WebSocket
    // ============================================================
    const ws = new WebSocket('ws://' + window.location.host);

    let tickIntervalMs = 300000;
    let lastTickStartMs = Date.now();
    let currentTick = 0;
    let prevPrestige = new Map();

    // Unified feed correlation:
    //   feedByEntryId[entryId]  → DOM node for paid actions
    //   feedByTxHash[txHash]    → DOM node once tx hash is known (post-settle)
    const feedByEntryId = new Map();
    const feedByTxHash = new Map();
    // Free-event entries are keyed by event.id in feedByEntryId too.

    const STATUS_LABEL = {
      pending:   'Pending Authorization',
      submitted: 'In Settlement',
      settled:   'Cleared & Reconciled',
      failed:    'Settlement Exception',
    };

    const STATUS_PRIORITY = { pending: 0, submitted: 1, settled: 2, failed: 2 };

    const TYPE_LABEL = {
      action: 'Standup',
      payment: 'Settlement',
      payment_failed: 'Settlement Failed',
      alliance_formed: 'Alliance Formed',
      alliance_rejected: 'Alliance Rejected',
      alliance_broken: 'Alliance Broken',
      random_event: 'Q1 Memo',
      status_effect: 'HR Update',
      game_start: 'Cycle Begins',
      game_end: 'Cycle Closed',
      game_halted: 'Strategic Pause',
      game_resumed: 'Resumed',
    };

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.type === 'full_state') updateFullState(msg.data);
      else if (msg.type === 'game_event') handleGameEvent(msg.data);
      else if (msg.type === 'ticker_update') handleTickerUpdate(msg.data);
    };

    // ============================================================
    // Initial state
    // ============================================================
    function updateFullState(data) {
      tickIntervalMs = data.tickIntervalMs || tickIntervalMs;
      currentTick = data.tick;
      lastTickStartMs = Date.now() - 0; // best estimate; will recalibrate on next tick
      document.getElementById('cycle').textContent = data.tick;
      document.getElementById('status').textContent = humanStatus(data.status);
      document.getElementById('halted-overlay').classList.toggle('hidden', data.status !== 'halted');

      // Stats
      setKpis(data.stats.totalAmountMoved, data.stats.totalTransactions, data.stats.avgSettlementTime, data.agents.length);

      // Leaderboard
      data.agents.forEach(a => prevPrestige.set(a.id, a.prestige));
      renderLeaderboard(data.agents);

      // Feed: replay events + ticker, sorted by tick desc / time desc
      const stream = document.getElementById('stream');
      stream.innerHTML = '';
      feedByEntryId.clear();
      feedByTxHash.clear();

      // Build a chronological list (oldest first) so we can prepend each.
      const items = [];
      for (const e of data.recentEvents) items.push({ kind: 'event', payload: e, ts: new Date(e.timestamp).getTime() });
      for (const t of data.ticker) items.push({ kind: 'ticker', payload: t, ts: t.settledAt || t.submittedAt || 0 });
      items.sort((a, b) => a.ts - b.ts);
      for (const it of items) {
        if (it.kind === 'event') handleGameEvent(it.payload, /*replay*/ true);
        else handleTickerUpdate(it.payload, /*replay*/ true);
      }
      if (stream.children.length === 0) {
        stream.innerHTML = '<div class="empty-state">Waiting for the first cycle to begin…</div>';
      }
    }

    // ============================================================
    // Live updates
    // ============================================================
    function handleGameEvent(event, replay) {
      // Tick boundary detection — reset the countdown when we see a higher tick.
      if (typeof event.tick === 'number' && event.tick > currentTick) {
        currentTick = event.tick;
        lastTickStartMs = Date.now();
        document.getElementById('cycle').textContent = currentTick;
        document.getElementById('banner').classList.remove('tick-pulse');
        // force reflow to restart animation
        void document.getElementById('banner').offsetWidth;
        document.getElementById('banner').classList.add('tick-pulse');
      }

      // Paid action: merge into existing pending/settled entry by tx hash.
      if (event.txHash && feedByTxHash.has(event.txHash)) {
        const row = feedByTxHash.get(event.txHash);
        enrichPaidRowWithEvent(row, event);
        return;
      }

      // Free action (or paid event without a matched ticker — fallback): create a fresh entry.
      const row = renderFreeFeedEntry(event);
      feedByEntryId.set(event.id, row);
      prependFeedEntry(row, replay);

      // Refresh leaderboard since prestige might have moved.
      if (!replay) scheduleLeaderboardRefresh();
    }

    function handleTickerUpdate(entry, replay) {
      const existing = feedByEntryId.get(entry.id);
      if (existing) {
        updatePaidFeedRow(existing, entry);
      } else {
        const row = renderPaidFeedEntry(entry);
        feedByEntryId.set(entry.id, row);
        if (entry.txHash) feedByTxHash.set(entry.txHash, row);
        prependFeedEntry(row, replay);
      }
      // Also keep tx-hash index up to date if the hash arrived this update.
      if (entry.txHash) {
        feedByTxHash.set(entry.txHash, feedByEntryId.get(entry.id));
      }

      // Visual pulse on terminal states.
      if (entry.status === 'settled' && !replay) {
        const row = feedByEntryId.get(entry.id);
        row.classList.remove('flash-settled'); void row.offsetWidth; row.classList.add('flash-settled');
      } else if (entry.status === 'failed' && !replay) {
        const row = feedByEntryId.get(entry.id);
        row.classList.remove('flash-failed'); void row.offsetWidth; row.classList.add('flash-failed');
      }

      if (!replay) scheduleLeaderboardRefresh();
    }

    function prependFeedEntry(row, replay) {
      const stream = document.getElementById('stream');
      const empty = stream.querySelector('.empty-state');
      if (empty) empty.remove();
      stream.insertBefore(row, stream.firstChild);
      if (replay) row.style.animation = 'none';
      // Cap to 60 entries.
      while (stream.children.length > 60) stream.removeChild(stream.lastChild);
    }

    // ============================================================
    // Renderers
    // ============================================================
    function renderPaidFeedEntry(t) {
      const div = document.createElement('article');
      div.className = 'feed-entry paid';
      if (t.txHash) div.dataset.txHash = t.txHash;
      div.dataset.entryId = t.id;
      div.innerHTML = paidFeedInnerHTML(t, /*outcome*/ null);
      return div;
    }

    function renderFreeFeedEntry(e) {
      const div = document.createElement('article');
      div.className = 'feed-entry free';
      if (e.txHash) div.dataset.txHash = e.txHash;
      div.dataset.eventId = e.id;
      div.innerHTML = freeFeedInnerHTML(e);
      return div;
    }

    function updatePaidFeedRow(row, t) {
      // Preserve any outcome/event description that was already added.
      const outcomeNode = row.querySelector('.feed-outcome');
      const outcome = outcomeNode ? outcomeNode.textContent : null;
      row.innerHTML = paidFeedInnerHTML(t, outcome);
      if (t.txHash) row.dataset.txHash = t.txHash;
    }

    function enrichPaidRowWithEvent(row, event) {
      const entryId = row.dataset.entryId;
      // Pull current ticker fields back out of the DOM (rough but works); the next
      // ticker_update will re-render cleanly. For now, just append outcome + reasoning.
      const existingQuote = row.querySelector('.feed-quote');
      if (event.reasoning && !existingQuote) {
        const q = document.createElement('blockquote');
        q.className = 'feed-quote';
        q.textContent = '"' + event.reasoning + '"';
        row.appendChild(q);
      }
      const existingOutcome = row.querySelector('.feed-outcome');
      if (event.description && !existingOutcome) {
        const o = document.createElement('div');
        o.className = 'feed-outcome';
        o.textContent = stripActorPrefix(event.description);
        row.appendChild(o);
      }
    }

    function paidFeedInnerHTML(t, outcomeText) {
      const time = formatTime(t.settledAt || t.submittedAt || Date.now());
      const statusKey = t.status || 'pending';
      const statusLabel = STATUS_LABEL[statusKey] || statusKey;
      const settlementHtml = t.settlementTime != null
        ? '<span class="settlement-time">⏱ ' + t.settlementTime.toFixed(1) + 's</span>'
        : '';
      const txHtml = t.txHash
        ? '<span class="tx-link">tx: ' + (t.explorerUrl
            ? '<a href="' + t.explorerUrl + '" target="_blank" rel="noopener">' + shortHash(t.txHash) + ' ↗</a>'
            : shortHash(t.txHash)) + '</span>'
        : '';
      const quoteHtml = t.reasoning ? '<blockquote class="feed-quote">"' + escape(t.reasoning) + '"</blockquote>' : '';
      const errorHtml = t.error ? '<div class="feed-error">Network response: ' + escape(t.error) + '</div>' : '';
      const outcomeHtml = outcomeText ? '<div class="feed-outcome">' + escape(outcomeText) + '</div>' : '';

      return ''
        + '<div class="feed-head">'
        +   '<span class="cycle">Cycle ' + (t.cycle || currentTick) + '</span>'
        +   '<span>' + time + '</span>'
        +   '<span class="badge-type ' + (statusKey === 'failed' ? 'payment_failed' : 'payment') + '">' + (statusKey === 'failed' ? 'Settlement Failed' : 'Settlement') + '</span>'
        + '</div>'
        + '<div class="feed-action">'
        +   '<span class="actor">' + escape(t.fromAgentName) + '</span>'
        +   '<span class="arrow">→</span>'
        +   '<span class="recipient">' + escape(t.toService) + '</span>'
        + '</div>'
        + '<div class="feed-mpp">'
        +   '<span class="amount">$' + (t.amount != null ? Number(t.amount).toFixed(2) : '0.00') + ' DLBR</span>'
        +   '<span class="status-badge ' + statusKey + '">' + statusLabel + '</span>'
        +   settlementHtml
        +   txHtml
        + '</div>'
        + errorHtml
        + quoteHtml
        + outcomeHtml;
    }

    function freeFeedInnerHTML(e) {
      const time = formatTime(new Date(e.timestamp).getTime());
      const type = e.type || 'action';
      const label = TYPE_LABEL[type] || type;
      const quoteHtml = e.reasoning ? '<blockquote class="feed-quote">"' + escape(e.reasoning) + '"</blockquote>' : '';
      const prestigeHtml = e.prestigeChange
        ? '<div class="feed-outcome">Prestige adjustment: ' + (e.prestigeChange > 0 ? '+' : '') + e.prestigeChange + '</div>'
        : '';
      return ''
        + '<div class="feed-head">'
        +   '<span class="cycle">Cycle ' + (e.tick != null ? e.tick : currentTick) + '</span>'
        +   '<span>' + time + '</span>'
        +   '<span class="badge-type ' + type + '">' + label + '</span>'
        + '</div>'
        + '<div class="feed-action">' + escape(e.description) + '</div>'
        + quoteHtml
        + prestigeHtml;
    }

    function stripActorPrefix(desc) {
      // "Chad Synergize: Sent diane to sensitivity training" → "Sent diane to sensitivity training"
      const i = desc.indexOf(':');
      return i > 0 ? desc.slice(i + 1).trim() : desc;
    }

    // ============================================================
    // Leaderboard (with rank-shuffle FLIP animation)
    // ============================================================
    function renderLeaderboard(agents) {
      const sorted = agents.slice().sort((a, b) => b.prestige - a.prestige);
      const lb = document.getElementById('leaderboard');

      // Capture old positions (FLIP)
      const before = new Map();
      lb.querySelectorAll('.manager-row').forEach(el => {
        before.set(el.dataset.agentId, el.getBoundingClientRect().top);
      });

      // Rebuild
      lb.innerHTML = sorted.map((a, i) => managerRowHTML(a, i)).join('') ||
        '<div class="empty-state">No managers reporting yet.</div>';

      // Animate (FLIP)
      lb.querySelectorAll('.manager-row').forEach(el => {
        const oldTop = before.get(el.dataset.agentId);
        const newTop = el.getBoundingClientRect().top;
        if (oldTop != null && oldTop !== newTop) {
          const dy = oldTop - newTop;
          el.style.transform = 'translateY(' + dy + 'px)';
          el.style.transition = 'none';
          requestAnimationFrame(() => {
            el.style.transition = 'transform 0.45s ease';
            el.style.transform = '';
          });
        }
        // Pulse prestige if it changed since last render
        const id = el.dataset.agentId;
        const a = sorted.find(x => x.id === id);
        if (a && prevPrestige.has(id) && prevPrestige.get(id) !== a.prestige) {
          const p = el.querySelector('.prestige');
          if (p) { p.classList.remove('bumped'); void p.offsetWidth; p.classList.add('bumped'); }
        }
      });

      // Update memory of last-seen prestige
      sorted.forEach(a => prevPrestige.set(a.id, a.prestige));
    }

    function managerRowHTML(a, i) {
      const rank = i + 1;
      const traits = personaTraits(a.id);
      const traitText = traits ? ('A' + traits.aggression + ' · G' + traits.greed + ' · C' + traits.caution + ' · L' + traits.loyalty) : '';
      const badges = (a.statusEffects || []).map(e =>
        '<span class="badge ' + e.type + '">' + e.type.replace(/_/g, ' ') + '</span>'
      ).join('');
      return '<div class="manager-row rank-' + rank + '" data-agent-id="' + a.id + '">'
        + '<div class="rank">' + rank + '</div>'
        + '<div class="manager-identity">'
        +   '<div class="name">' + escape(a.name) + '</div>'
        +   '<div class="title">' + escape(a.title) + '</div>'
        +   (traitText ? '<div class="traits">' + traitText + '</div>' : '')
        +   (badges ? '<div class="badges">' + badges + '</div>' : '')
        + '</div>'
        + '<div class="manager-stats">'
        +   '<div class="prestige">' + a.prestige + '</div>'
        +   '<div class="balance' + ((a.balance != null && a.balance < 50) ? ' low' : '') + '">$' + (a.balance != null ? Number(a.balance).toFixed(0) : '–') + '</div>'
        + '</div>'
        + '</div>';
    }

    // Hardcoded persona traits for inline display (must match agents/personas.ts).
    // This is just for the in-leaderboard "A85 · G70 · C20 · L40" line.
    const PERSONA_TRAITS = {
      chad:     { aggression: 85, greed: 70, caution: 20, loyalty: 40 },
      linda:    { aggression: 30, greed: 50, caution: 90, loyalty: 60 },
      trevor:   { aggression: 70, greed: 40, caution: 30, loyalty: 20 },
      brenda:   { aggression: 20, greed: 30, caution: 95, loyalty: 80 },
      kevin:    { aggression: 80, greed: 95, caution: 25, loyalty: 15 },
      diane:    { aggression: 40, greed: 40, caution: 70, loyalty: 70 },
      marcus:   { aggression: 60, greed: 60, caution: 50, loyalty: 85 },
      stacy:    { aggression: 35, greed: 25, caution: 45, loyalty: 50 },
      ron:      { aggression: 25, greed: 80, caution: 85, loyalty: 30 },
      jen:      { aggression: 65, greed: 55, caution: 40, loyalty: 65 },
    };
    function personaTraits(id) { return PERSONA_TRAITS[id] || null; }

    // ============================================================
    // KPIs
    // ============================================================
    function setKpis(amount, count, velocity, headcount) {
      animateNumber('kpi-amount', amount, v => v.toFixed(2));
      animateNumber('kpi-count', count, v => v.toFixed(0));
      animateNumber('kpi-velocity-val', velocity, v => v.toFixed(1));
      animateNumber('kpi-headcount', headcount, v => v.toFixed(0));
    }
    function animateNumber(id, target, fmt) {
      const el = document.getElementById(id);
      if (!el) return;
      const current = parseFloat((el.textContent || '0').replace(/[^0-9.\\-]/g, '')) || 0;
      if (current === target) return;
      const tile = el.closest('.kpi-tile');
      const start = current;
      const delta = target - start;
      const duration = 600;
      const startTime = performance.now();
      function step(now) {
        const t = Math.min(1, (now - startTime) / duration);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(start + delta * eased);
        if (t < 1) requestAnimationFrame(step);
        else el.textContent = fmt(target);
      }
      requestAnimationFrame(step);
      if (tile && delta !== 0) {
        tile.classList.remove('value-bumped'); void tile.offsetWidth; tile.classList.add('value-bumped');
      }
    }

    // ============================================================
    // Periodic state refresh (debounced). Triggered by every event.
    // ============================================================
    let leaderboardRefreshTimer = null;
    function scheduleLeaderboardRefresh() {
      if (leaderboardRefreshTimer) return;
      leaderboardRefreshTimer = setTimeout(() => {
        leaderboardRefreshTimer = null;
        refreshFromApi();
      }, 800);
    }
    async function refreshFromApi() {
      try {
        const r = await fetch('/api/state');
        const data = await r.json();
        document.getElementById('cycle').textContent = data.tick;
        document.getElementById('status').textContent = humanStatus(data.status);
        document.getElementById('halted-overlay').classList.toggle('hidden', data.status !== 'halted');
        renderLeaderboard(data.agents);
        setKpis(data.stats.amountMoved, data.stats.total, data.stats.avgSettlement, data.agents.length);
      } catch (e) { /* network blip; next event will retry */ }
    }

    // ============================================================
    // Countdown (client-side timer — no server roundtrip)
    // ============================================================
    setInterval(() => {
      const elapsed = Date.now() - lastTickStartMs;
      const remaining = Math.max(0, tickIntervalMs - elapsed);
      const sec = Math.floor(remaining / 1000);
      const m = Math.floor(sec / 60);
      const s = sec % 60;
      const el = document.getElementById('countdown');
      el.textContent = m + ':' + (s < 10 ? '0' + s : s);
      el.classList.remove('tick'); void el.offsetWidth; el.classList.add('tick');
    }, 1000);

    // ============================================================
    // Helpers
    // ============================================================
    function escape(s) {
      return String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }
    function shortHash(h) {
      return h ? h.slice(0, 4) + '…' + h.slice(-4) : '';
    }
    function formatTime(ms) {
      const d = new Date(ms);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      return hh + ':' + mm + ':' + ss;
    }
    function humanStatus(s) {
      if (s === 'running') return 'Operating';
      if (s === 'halted') return 'On Pause';
      if (s === 'ended') return 'Q1 Closed';
      if (s === 'setup') return 'Initializing';
      return s;
    }
  </script>
</body>
</html>`;

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  import("../lib/db.js").then(({ initDatabase }) => {
    initDatabase();
    startDisplayServer();
  });
}
