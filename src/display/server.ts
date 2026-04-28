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

// HTML for the display page
const DISPLAY_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Quarterly Ascension</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: 'Courier New', monospace;
      background: #0a0a0a;
      color: #00ff00;
      min-height: 100vh;
      padding: 20px;
    }
    .container {
      display: grid;
      grid-template-columns: 1fr 350px;
      gap: 20px;
      max-width: 1800px;
      margin: 0 auto;
    }
    .header {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 15px 20px;
      background: #111;
      border: 1px solid #333;
    }
    .title {
      font-size: 24px;
      font-weight: bold;
    }
    .status {
      display: flex;
      gap: 30px;
      font-size: 14px;
    }
    .status-item { color: #888; }
    .status-value { color: #00ff00; }
    .panel {
      background: #111;
      border: 1px solid #333;
      padding: 15px;
    }
    .panel-title {
      font-size: 14px;
      color: #888;
      margin-bottom: 15px;
      border-bottom: 1px solid #333;
      padding-bottom: 10px;
    }
    .main-content {
      display: flex;
      flex-direction: column;
      gap: 20px;
    }

    /* Leaderboard */
    .leaderboard { display: flex; flex-direction: column; gap: 8px; }
    .agent-row {
      display: grid;
      grid-template-columns: 30px 1fr 80px 80px;
      gap: 10px;
      padding: 8px;
      background: #1a1a1a;
      align-items: center;
    }
    .agent-row:nth-child(1) { border-left: 3px solid gold; }
    .agent-row:nth-child(2) { border-left: 3px solid silver; }
    .agent-row:nth-child(3) { border-left: 3px solid #cd7f32; }
    .rank { color: #666; }
    .agent-name { font-weight: bold; }
    .agent-title { font-size: 11px; color: #666; }
    .prestige { color: #00ff00; text-align: right; }
    .budget { color: #ffcc00; text-align: right; }
    .budget.low { color: #ff4444; }

    /* Event Feed */
    .event-feed {
      max-height: 300px;
      overflow-y: auto;
      display: flex;
      flex-direction: column;
      gap: 10px;
    }
    .event {
      padding: 10px;
      background: #1a1a1a;
      border-left: 3px solid #333;
      font-size: 13px;
    }
    .event.payment { border-left-color: #00ff00; }
    .event.payment_failed { border-left-color: #ff4444; }
    .event.alliance_formed { border-left-color: #00ccff; }
    .event.alliance_broken { border-left-color: #ff00ff; }
    .event.random_event { border-left-color: #ffcc00; }
    .event-time { color: #666; font-size: 11px; }
    .event-desc { margin-top: 5px; }
    .event-quote {
      margin-top: 6px;
      padding: 6px 8px;
      background: #0d0d0d;
      border-left: 2px solid #444;
      font-size: 12px;
      font-style: italic;
      color: #bbb;
      line-height: 1.4;
      white-space: pre-wrap;
    }

    /* Hover-link: when you hover on either an event or a ticker entry that
       has a tx hash, both halves of the pair pulse so the eye can connect
       the in-character action to its on-chain settlement. */
    .event[data-tx-hash], .ticker-entry[data-tx-hash] { cursor: pointer; transition: background 0.15s; }
    .event.linked-hover, .ticker-entry.linked-hover {
      background: #1f2a1f !important;
      box-shadow: 0 0 0 1px #00ff00 inset;
    }

    /* Payment Ticker */
    .ticker {
      display: flex;
      flex-direction: column;
      gap: 12px;
      max-height: calc(100vh - 200px);
      overflow-y: auto;
    }
    .ticker-entry {
      padding: 12px;
      background: #1a1a1a;
      border-left: 3px solid #333;
    }
    .ticker-entry.pending { border-left-color: #ffcc00; }
    .ticker-entry.submitted { border-left-color: #00ccff; }
    .ticker-entry.settled { border-left-color: #00ff00; }
    .ticker-entry.failed { border-left-color: #ff4444; background: #2a1a1a; }
    .ticker-from { font-weight: bold; }
    .ticker-to { color: #888; }
    .ticker-amount { color: #00ff00; font-size: 16px; margin: 5px 0; }
    .ticker-tx {
      font-size: 11px;
      color: #666;
      word-break: break-all;
    }
    .ticker-tx a { color: #00ccff; text-decoration: none; }
    .ticker-tx a:hover { text-decoration: underline; }
    .ticker-time { font-size: 11px; color: #888; margin-top: 5px; }
    .ticker-status {
      display: inline-block;
      padding: 2px 6px;
      font-size: 10px;
      border-radius: 3px;
      margin-left: 5px;
    }
    .ticker-status.pending { background: #3d3d00; color: #ffcc00; }
    .ticker-status.submitted { background: #003d3d; color: #00ccff; }
    .ticker-status.settled { background: #003d00; color: #00ff00; }
    .ticker-status.failed { background: #3d0000; color: #ff4444; }
    .ticker-quote {
      margin-top: 8px;
      padding: 8px 10px;
      background: #0d0d0d;
      border-left: 2px solid #444;
      font-size: 12px;
      font-style: italic;
      color: #bbb;
      line-height: 1.4;
      white-space: pre-wrap;
    }

    /* Stats footer */
    .stats-footer {
      grid-column: 1 / -1;
      display: flex;
      justify-content: space-between;
      padding: 15px 20px;
      background: #111;
      border: 1px solid #333;
      font-size: 12px;
      color: #888;
    }
    .stat-value { color: #00ff00; }

    /* Halted state */
    .halted-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0,0,0,0.9);
      display: flex;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      z-index: 1000;
    }
    .halted-overlay.hidden { display: none; }
    .halted-text {
      font-size: 48px;
      color: #ffcc00;
      margin-bottom: 20px;
    }
    .halted-subtext { color: #888; }
  </style>
</head>
<body>
  <div id="halted-overlay" class="halted-overlay hidden">
    <div class="halted-text">⏸️ GAME PAUSED</div>
    <div class="halted-subtext">Halted by admin · State preserved · Awaiting resume</div>
  </div>

  <div class="container">
    <div class="header">
      <div class="title">QUARTERLY ASCENSION</div>
      <div class="status">
        <div class="status-item">Tick: <span class="status-value" id="tick">0</span></div>
        <div class="status-item">Status: <span class="status-value" id="status">setup</span></div>
        <div class="status-item">Agents: <span class="status-value" id="agent-count">0</span></div>
      </div>
    </div>

    <div class="main-content">
      <div class="panel">
        <div class="panel-title">LEADERBOARD</div>
        <div class="leaderboard" id="leaderboard"></div>
      </div>

      <div class="panel">
        <div class="panel-title">LATEST ACTIONS</div>
        <div class="event-feed" id="events"></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-title">LIVE SETTLEMENTS</div>
      <div class="ticker" id="ticker"></div>
    </div>

    <div class="stats-footer">
      <div>TOTAL SETTLED: <span class="stat-value" id="total-tx">0</span> transactions</div>
      <div>DLBR MOVED: <span class="stat-value" id="total-amount">$0.00</span></div>
      <div>AVG SETTLEMENT: <span class="stat-value" id="avg-time">0.0s</span></div>
    </div>
  </div>

  <script>
    // Hover-link: highlight matching pairs of (event, ticker entry) by tx hash.
    // Both halves of the pair pulse so the eye can connect the in-character
    // action description to its on-chain settlement.
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

    const ws = new WebSocket('ws://' + window.location.host);

    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === 'full_state') {
        updateFullState(msg.data);
      } else if (msg.type === 'game_event') {
        addEvent(msg.data);
        scheduleLeaderboardRefresh();
      } else if (msg.type === 'ticker_update') {
        updateTicker(msg.data);
        scheduleLeaderboardRefresh();
      }
    };

    // Coalesce rapid-fire updates: only re-fetch state at most every 1s.
    let leaderboardRefreshTimer = null;
    function scheduleLeaderboardRefresh() {
      if (leaderboardRefreshTimer) return;
      leaderboardRefreshTimer = setTimeout(() => {
        leaderboardRefreshTimer = null;
        refreshLeaderboardAndStats();
      }, 1000);
    }

    async function refreshLeaderboardAndStats() {
      try {
        const r = await fetch('/api/state');
        const data = await r.json();
        renderLeaderboard(data.agents);
        document.getElementById('tick').textContent = data.tick;
        document.getElementById('status').textContent = data.status;
        document.getElementById('agent-count').textContent = data.agents.length;
        document.getElementById('total-tx').textContent = data.stats.total;
        document.getElementById('total-amount').textContent = '$' + data.stats.amountMoved.toFixed(2);
        document.getElementById('avg-time').textContent = data.stats.avgSettlement.toFixed(1) + 's';
      } catch (e) {
        // Network blip; next event will retry.
      }
    }

    function renderLeaderboard(agents) {
      const leaderboard = document.getElementById('leaderboard');
      leaderboard.innerHTML = agents
        .slice()
        .sort((a, b) => b.prestige - a.prestige)
        .map((agent, i) => \`
          <div class="agent-row">
            <div class="rank">#\${i + 1}</div>
            <div>
              <div class="agent-name">\${agent.name}</div>
              <div class="agent-title">\${agent.title}</div>
            </div>
            <div class="prestige">\${agent.prestige}</div>
            <div class="budget \${agent.balance < 50 ? 'low' : ''}">\$\${agent.balance.toFixed(0)}</div>
          </div>
        \`).join('');
    }

    function updateFullState(data) {
      document.getElementById('tick').textContent = data.tick;
      document.getElementById('status').textContent = data.status;
      document.getElementById('agent-count').textContent = data.agents.length;

      // Halted overlay
      const overlay = document.getElementById('halted-overlay');
      if (data.status === 'halted') {
        overlay.classList.remove('hidden');
      } else {
        overlay.classList.add('hidden');
      }

      // Leaderboard
      renderLeaderboard(data.agents);

      // Events
      const events = document.getElementById('events');
      events.innerHTML = data.recentEvents.map(e => renderEvent(e)).join('');

      // Ticker
      const ticker = document.getElementById('ticker');
      ticker.innerHTML = data.ticker.map(t => renderTickerEntry(t)).join('');

      // Stats
      document.getElementById('total-tx').textContent = data.stats.totalTransactions;
      document.getElementById('total-amount').textContent = '$' + data.stats.totalAmountMoved.toFixed(2);
      document.getElementById('avg-time').textContent = data.stats.avgSettlementTime.toFixed(1) + 's';
    }

    function addEvent(event) {
      const events = document.getElementById('events');
      const html = renderEvent(event);
      events.insertAdjacentHTML('afterbegin', html);

      // Keep max 20 events
      while (events.children.length > 20) {
        events.removeChild(events.lastChild);
      }
    }

    function updateTicker(entry) {
      const ticker = document.getElementById('ticker');
      const existingEl = document.querySelector(\`[data-ticker-id="\${entry.id}"]\`);

      if (existingEl) {
        existingEl.outerHTML = renderTickerEntry(entry);
      } else {
        ticker.insertAdjacentHTML('afterbegin', renderTickerEntry(entry));

        // Keep max 15 entries
        while (ticker.children.length > 15) {
          ticker.removeChild(ticker.lastChild);
        }
      }

      // Update stats
      fetch('/api/state')
        .then(r => r.json())
        .then(data => {
          document.getElementById('total-tx').textContent = data.stats.total;
          document.getElementById('total-amount').textContent = '$' + data.stats.amountMoved.toFixed(2);
          document.getElementById('avg-time').textContent = data.stats.avgSettlement.toFixed(1) + 's';
        });
    }

    function renderEvent(e) {
      const time = new Date(e.timestamp).toLocaleTimeString();
      const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
      const txAttr = e.txHash ? \` data-tx-hash="\${e.txHash}"\` : '';
      const quoteHtml = e.reasoning
        ? \`<div class="event-quote">"\${escapeHtml(e.reasoning)}"</div>\`
        : '';
      return \`
        <div class="event \${e.type}"\${txAttr}>
          <div class="event-time">\${time} · Tick \${e.tick}</div>
          <div class="event-desc">\${e.description}</div>
          \${quoteHtml}
        </div>
      \`;
    }

    function renderTickerEntry(t) {
      const statusClass = t.status;
      const statusText = t.status === 'settled' ? '✓ settled' :
                        t.status === 'failed' ? '✗ FAILED' :
                        t.status === 'submitted' ? 'broadcasting...' : 'signing...';

      let txLink = '';
      if (t.txHash) {
        const shortHash = t.txHash.slice(0, 4) + '...' + t.txHash.slice(-4);
        txLink = t.explorerUrl
          ? \`<a href="\${t.explorerUrl}" target="_blank">\${shortHash}</a>\`
          : shortHash;
      }

      const escapeHtml = (s) => String(s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

      const quoteHtml = t.reasoning
        ? \`<div class="ticker-quote">"\${escapeHtml(t.reasoning)}"</div>\`
        : '';

      const txAttr = t.txHash ? \` data-tx-hash="\${t.txHash}"\` : '';

      return \`
        <div class="ticker-entry \${statusClass}" data-ticker-id="\${t.id}"\${txAttr}>
          <div class="ticker-from">\${t.fromAgentName}</div>
          <div class="ticker-to">→ \${t.toService}</div>
          <div class="ticker-amount">\$\${t.amount.toFixed(2)} DLBR</div>
          \${t.txHash ? \`<div class="ticker-tx">tx: \${txLink}</div>\` : ''}
          <div class="ticker-time">
            \${t.settlementTime ? '⏱ ' + t.settlementTime.toFixed(1) + 's' : ''}
            <span class="ticker-status \${statusClass}">\${statusText}</span>
          </div>
          \${t.error ? \`<div class="ticker-tx" style="color: #ff4444">reason: \${t.error}</div>\` : ''}
          \${quoteHtml}
        </div>
      \`;
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
