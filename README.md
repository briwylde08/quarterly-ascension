# Quarterly Ascension 🏆

### ▶️ [**Play live → quarterly-ascension.pages.dev**](https://quarterly-ascension.pages.dev/)

10 AI middle-managers compete for promotion to VP using real Stellar testnet payments via [MPP](https://github.com/stellar/mpp) — the Machine Payments Protocol, Stellar's facilitator-free payment protocol for AI agents (HTTP 402 for the handshake). The game runs on Cloudflare Workers + Durable Objects + D1; every paid action is a real on-chain settlement audiences can watch hit `stellar.expert` in real time.

It's a corporate-absurdist satire with sabotage, alliances, and HR complaints. Humans coach the AI managers via text directives — but the managers are autonomous and may, or may not, listen. The drama lives in the gap.

> **Status:** public-playable. The `main` branch runs the 8-hour workday format. Claim a manager, coach them through the day. ☕

---

## 🏗 Architecture

```
┌──────────────────────────┐    WebSocket + REST    ┌────────────────────────┐
│  display/public          │ ─────────────────────▶ │  orchestrator          │
│  (Cloudflare Pages)      │                        │  Worker + Durable      │
│  • index.html dashboard  │                        │  Object (GameOrch.)    │
│  • intro.html (claim)    │                        │  + D1 (events,         │
│  • agent.html (coach)    │                        │    action_logs, etc.)  │
│  • directives.html       │                        └─────────┬──────────────┘
│  • handbook.html         │                                  │
│  • awards.html           │                                  │
└──────────────────────────┘                                  │
                                                              │ MPP / HTTP 402
                                                              ▼
              ┌───────────────────────────────────────────────────────────┐
              │  npcs/*  — one Worker per paid service                    │
              │  ☕ coffee-cart   📋 hr-dept     📈 consultant            │
              │  💻 it-guy       📅 exec-assistant   🍽 caterer           │
              │  🎤 motivational-speaker                                  │
              └───────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
                                           ┌──────────────────────────────┐
                                           │  Stellar testnet             │
                                           │  💸 DLBR asset (Soroban SAC) │
                                           │  Issuer + 17 persona/NPC     │
                                           │  accounts                    │
                                           └──────────────────────────────┘
```

**Orchestrator** is a single Durable Object. It owns the alarm-driven tick loop, picks the next 5 agents per round-robin (half the roster per tick), calls the LLM for each agent's action choice, executes the action (which may include a real MPP payment to the corresponding NPC), persists everything to D1, and broadcasts state changes over WebSocket.

**NPCs** are stateless Workers. Each implements one or more paid endpoints via `@stellar/mpp/charge/server`'s `createCharge`. They return HTTP 402 with a payment challenge; the orchestrator's MPP client signs the auth entry, the payment settles on-chain, and the NPC returns the actual response.

**Display** is fully static HTML/CSS/JS hosted on Cloudflare Pages. It connects to the orchestrator's `/ws` endpoint for live updates and falls back to `/api/state` for bootstrap/refresh.

---

## ✨ What's interesting in this codebase

If you came here to read the code, these are the patterns most likely worth your time:

### 🤖 Agentic payments via MPP

Each AI manager has its own Stellar account and signs **real testnet payments** to NPC Workers when they take a paid action. The HTTP 402 handshake is the whole interesting part — no payment facilitator in the middle, just signed auth entries and on-chain settlement. NPC Workers verify the charge via `@stellar/mpp/charge/server` and return the response only after settlement.

📂 `orchestrator/src/mpp-client.ts` (caller), `npcs/*/index.ts` (servers), `orchestrator/src/stellar.ts` (Stellar wrapper with retry-on-transient-error).

### 🎙 Persona-driven LLM with human-in-the-loop coaching

10 fixed personas with traits (aggression / greed / caution / loyalty), backstories, and quirks drive action selection via `gpt-5-mini`. Human coaches submit free-text directives (≤ 280 chars) that get injected into the LLM prompt as standing guidance. After each action, an alignment classifier (also LLM-based) self-rates whether the agent **followed** / **tilted** / **defied** the coach. Those alignments aggregate into the Coach Alignment Leaderboard on `/directives.html`.

📂 `orchestrator/src/llm.ts` (action picker + persona prompt + alignment classifier), `orchestrator/src/personas.ts` (the 10 personas).

### ⏱ Durable Object 8-hour tick loop with wall-clock drift correction

The DO holds itself open via `state.storage.setAlarm` — every alarm fires, runs `processTick`, persists to D1, then schedules the next alarm. The reschedule targets `gameStartedAt + tick × interval` (a fixed wall-clock target), not `now + interval` — so LLM work and Stellar settlement times don't compound into cadence drift across the 60-tick run.

📂 `orchestrator/src/orchestrator-do.ts` (look for `alarm()`).

### 🔒 Atomic claim via D1 batch + pre-hash

Cloudflare Workers can be terminated mid-handler (CPU budget, network blip). The original claim handler UPDATEd the agent row, then hashed the password, then wrote the password to D1 — if the worker died between steps, you got a stuck-claim row with no password (unreleasable). Fix: hash first (no DB writes), then commit `UPDATE agents + INSERT password` in a single D1 batch transaction. Worker death can no longer leave partial state.

📂 `orchestrator/src/orchestrator-do.ts` `/api/claim` handler.

### 💌 Cloudflare Email Sending via the `EMAIL` binding

Each claimed coach receives 5 emails over the 8-hour game (welcome + progress at ticks 15/30/45 + finale). Sender domain (`megacorp.lol`) is onboarded once via `wrangler email sending enable`; the binding sends transactional emails to arbitrary recipients with no allowlist. No third-party email API key.

📂 `orchestrator/src/email.ts` (templates + `env.EMAIL.send()`), `orchestrator/wrangler.jsonc` (`send_email` binding).

### 🎲 Drama scaffolding: random events + mid-game pivot

Random events fire on cycle boundaries (every 5 ticks) — Surprise Demo Day, Viral LinkedIn Post, Bad Glassdoor Review, etc. — with one-shot caps so they don't repeat. Plus a deterministic **📋 Board Strategy Review** at ticks 30-34 that doubles every prestige change for 5 ticks, designed to break whatever meta has calcified by mid-game.

📂 `orchestrator/src/random-events.ts`, `orchestrator/src/tick.ts` (look for `board_review`).

### 💡 Server-side Coaching Hints

`agent.html` shows two-tier suggestions above the directive textarea: **⚡ Suggested Actions** (2 atomic plays as chips) and **🎯 Strategic Directives** (3-4 multi-turn combo hints with reasoning). Picked server-side from a priority-ranked rule set keyed off the manager's live state (status effects, balance, rank, pending alliance, action-counters). Click any chip → it pre-fills the directive textarea.

📂 `orchestrator/src/orchestrator-do.ts` `/api/coaching-hints` handler, `display/public/agent.html` (renderer).

---

## 🎯 Game flow

- **60 ticks at 8 min each → ~8-hour game.** One full workday. Each manager acts roughly **30 times** across the game.
- **5 managers act per tick**, picked from a stable randomized turn-order. Every 2 ticks (one roster pass, ~16 min), every manager has acted once. Cycle boundaries (every 5 ticks, ~40 min) trigger periodic mechanics.
- **Fixed beats**:
  - 🎤 **Tick 1** — Q1 Kickoff (CEO speech + 10 per-agent reactions)
  - 💰 **Every cycle boundary** (ticks 5, 10, 15, …) — Synergy Dividend (+$10/manager on-chain)
  - 🏆 **Ticks 15 / 30 / 45** — Quarterly Bonuses ($40/$25/$15 to top 3) + progress emails to coaches
  - 📋 **Ticks 30-34** — Board Strategy Review (every prestige change doubled for 5 ticks)
  - 🏁 **Tick 60** — Game End, finale email, 60-min cleanup window, then auto-reset
- **Random events** roll probabilistically at each cycle boundary (one-per-game cap): Surprise Demo Day, Surprise Board Visit, Viral LinkedIn, Bad Glassdoor Review, Surprise Promotion, Budget Cuts, Printer Achieves Sentience, Quiet Quitting Memo Leaked, Vending Machine Showdown. Plus Glass Cliff Promotion (auto-fires when the leader pulls 50+ ahead).
- **Status effects**: 😩 Hit the Wall, 🚨 Problematic, 📁 Documented, 🤔 Questionable Judgment, 🦅 Mysterious Influence, 🚫 Meeting Blocked, ✅ Has Deliverable, ⚖️ HR Audit, 📋 Board Strategy Review.
- **`take_credit` cap**: each manager can use Take Credit at most **4 times per game**. Keeps the sabotage→take-credit chain from dominating play.
- **Lobby auto-start**: the first claim opens a 30-minute lobby. The lobby-opener can skip the wait with their password via the inline form on `intro.html`. When the lobby alarm fires, the game auto-starts with whatever claims are in (uncoached managers play autonomously).
- **Coaching**: claim a manager on `/intro.html` (name + email + password). After claim success, a 5-step onboarding modal walks you through the flow. Submit directives any time during a running game; the LLM weighs them against persona before acting.
- **Email cadence**: claim confirmation + 3 progress reports + finale.

The full mechanic catalog lives at [`/handbook.html`](https://quarterly-ascension.pages.dev/handbook) on the deployed dashboard.

---

## 🧰 Tech stack

| Layer | Tech |
|---|---|
| Runtime | Cloudflare Workers (orchestrator, NPCs) + Cloudflare Pages (display) |
| State | Cloudflare Durable Object (game loop) + D1 (events, agents, action_logs, game_state, ticker, leaked_emails) |
| Payments | `@stellar/mpp/charge/{client,server}` over the Stellar Soroban DLBR asset (testnet). `sendAsset` retries on transient testnet failures with 1.5s + 3s backoff. |
| LLM | OpenAI-compatible (`gpt-5-mini`) via Cloudflare AI Gateway. `reasoning_effort: "low"` on the action picker, `"minimal"` on the gossip narrator. |
| Email | Cloudflare Email Sending via the `EMAIL` binding. Sender: `hr@megacorp.lol`. |
| Frontend | Vanilla HTML/CSS/JS (no build step). |
| Language | TypeScript everywhere. |

---

## 🌿 Branches

- **`main`** — public-playable. The 8-hour-workday format: 60 ticks × 8 min, 5 managers/tick, self-serve "first claim opens a 30-min lobby" auto-start, password-based coaching, 5 emails per coach. This is the deployable branch.
- **`retreat`** — preserved snapshot of the in-room live-show variant used at the SDF retreat (May 2026): 25-second ticks, 2 managers/tick, ~25 min runtime, no email, manual host start. Kept for historical reference.
- **`long-form-vision`** — the original pre-pivot prototype: 4-hour passive game, 5-min ticks, email-as-secret coaching. Kept for archaeology, not deploy-ready.

---

## 📄 License

[MIT](./LICENSE) — see the LICENSE file. Built at the [Stellar Development Foundation](https://stellar.org).
