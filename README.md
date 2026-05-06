# Quarterly Ascension

10 AI middle-managers compete for promotion to VP using real Stellar testnet payments via [MPP](https://github.com/stellar/mpp) (Machine Payments Protocol — Stellar's facilitator-free payment protocol for AI agents, using HTTP 402 for the handshake). The game runs on Cloudflare Workers + Durable Objects + D1; every paid action is a real on-chain settlement audiences can watch hit `stellar.expert` in real time.

> **Status:** retreat mode. The branch `long-form-vision` carries the original 4-hour passive game (5-min ticks, email-based coaching, 1-claim-per-human via email-as-secret). `main` is the live-show variant: 80 ticks at 25s each, 2-agents-per-tick round-robin, password-based coaching, ~33-min runtime.

---

## Architecture

```
┌──────────────────────────┐    WebSocket + REST    ┌────────────────────────┐
│  cloud/display/public    │ ─────────────────────▶ │  cloud/orchestrator    │
│  (Cloudflare Pages)      │                        │  Worker + Durable      │
│  • index.html dashboard  │                        │  Object (GameOrch.)    │
│  • directives.html       │                        │  + D1 (events,         │
│  • agent.html            │                        │    action_logs, etc.)  │
│  • handbook.html         │                        └─────────┬──────────────┘
└──────────────────────────┘                                  │
                                                              │ MPP / HTTP 402
                                                              ▼
              ┌───────────────────────────────────────────────────────────┐
              │  cloud/npcs/*  — one Worker per paid service              │
              │  coffee-cart  hr-dept  consultant  it-guy                 │
              │  exec-assistant  caterer  motivational-speaker            │
              └───────────────────────────────────────────────────────────┘
                                                              │
                                                              ▼
                                           ┌──────────────────────────────┐
                                           │  Stellar testnet             │
                                           │  DLBR asset (Soroban SAC)    │
                                           │  Issuer + 17 persona/NPC     │
                                           │  accounts                    │
                                           └──────────────────────────────┘
```

**Orchestrator** is a single Durable Object. It owns the alarm-driven tick loop, picks the next 2 agents per round-robin, calls the LLM for each agent's action choice, executes the action (which may include a real MPP payment to the corresponding NPC), persists everything to D1, and broadcasts state changes over WebSocket.

**NPCs** are stateless Workers. Each implements one or more paid endpoints via `@stellar/mpp/charge/server`'s `createCharge`. They return HTTP 402 with a payment challenge; the orchestrator's MPP client signs the auth entry, the payment settles on-chain, and the NPC returns the actual response.

**Display** is fully static HTML/CSS/JS hosted on Cloudflare Pages. It connects to the orchestrator's `/ws` endpoint for live updates and falls back to `/api/state` for bootstrap/refresh.

---

## Quick start (deploying from scratch)

You need: a Cloudflare account (Workers + Pages + D1 enabled), a Stellar testnet keypair to fund the asset issuer, and an OpenAI-compatible LLM endpoint (the project uses Cloudflare AI Gateway pointing at OpenAI's `gpt-5.5`).

### 1. Install

```bash
npm install
# Note: the workspace has a known peer-dep mismatch between
# @stellar/mpp@0.5.0 (peer mppx@^0.4.11) and the resolved mppx@0.5.13.
# If npm complains, --legacy-peer-deps is the working escape hatch.
# Tracked in issue #1.
```

### 2. Provision the D1 database

```bash
cd cloud/orchestrator
# Create the database (one-time)
npx wrangler d1 create quarterly-ascension
# Copy the database_id into wrangler.jsonc

# Apply migrations from cloud/db/migrations
npx wrangler d1 migrations apply quarterly-ascension --remote
```

### 3. Set Worker secrets

```bash
cd cloud/orchestrator
npx wrangler secret put ADMIN_SECRET           # admin endpoint bearer token
npx wrangler secret put OPENAI_API_KEY         # LLM key (OpenAI-compatible)
npx wrangler secret put CF_AIG_TOKEN           # Cloudflare AI Gateway token
npx wrangler secret put HR_DEPT_SECRET         # NPC funding source secret
npx wrangler secret put MOTIVATIONAL_SPEAKER_SECRET
npx wrangler secret put ASSET_ISSUER_SECRET    # DLBR issuer keypair (for HR replenish)

# Plus per-agent secrets (one per persona). See cloud/orchestrator/src/personas.ts
# for the canonical list and inject each as wrangler secret put AGENT_<ID>_SECRET.
```

### 4. Deploy

```bash
# Orchestrator
cd cloud/orchestrator && npx wrangler deploy

# Each NPC (repeat for each cloud/npcs/* directory)
cd cloud/npcs/coffee-cart && npx wrangler deploy
cd cloud/npcs/hr-dept && npx wrangler deploy
# ...

# Static display (run from repo root)
npm run deploy:display
```

### 5. Start a game

```bash
ORCH=https://orchestrator.<your-subdomain>.workers.dev
ADMIN=<your ADMIN_SECRET>

# Pre-assign coaches (10 slots)
curl -X POST "$ORCH/admin/preassign" \
  -H "Authorization: Bearer $ADMIN" \
  -H "Content-Type: application/json" \
  -d '{"assignments":[{"agentId":"jen","name":"Coach Name"}, ...]}'

# Each coach activates their slot (sets a password)
# POST /api/claim {agentId, name, password}

# Normalize on-chain balances to $200 starting budget
curl -X POST "$ORCH/admin/reset?normalize=true&target=200" \
  -H "Authorization: Bearer $ADMIN"

# Start the game
curl -X POST "$ORCH/admin/start" -H "Authorization: Bearer $ADMIN"
```

The dashboard at `https://<your-pages-subdomain>.pages.dev` will start showing the round-robin tick loop, paid actions settling on stellar.expert, and the leaderboard updating live.

---

## Local development

There's no local-dev fast path — the project depends on Durable Objects, D1, and live Stellar testnet, so iterations happen against the deployed worker.

```bash
# Typecheck (root + orchestrator + NPCs)
npm run typecheck
cd cloud/orchestrator && npx tsc --noEmit

# Smoke tests against deployed orchestrator
npx tsx scripts/smoke-test-d1.ts
npx tsx scripts/smoke-test-llm.ts
```

For UI iteration on the static dashboard: edit files in `cloud/display/public/` and re-run `npm run deploy:display`. The Pages project uses Direct Upload (no git integration), so what's on disk is what ships.

---

## Game flow (retreat mode)

- **80 ticks at 25s each → ~33-minute game.**
- Each alarm fires for **2 agents** picked from a rolling round-robin queue. Over 5 ticks (= 1 cycle), all 10 agents act once.
- Each agent's turn: LLM picks an action from the menu, the orchestrator executes it. Paid actions trigger an MPP payment to the relevant NPC, settle on-chain via the Soroban DLBR contract, and the receipt + tx hash flow back into the dashboard ticker.
- 9 random events sprinkled across the run: Q1 Kickoff, Bad Glassdoor Review, Quiet Quitting Memo, Surprise Promotion (Glass Cliff), Halftime Quarterly Bonus, Viral LinkedIn Post, Vending Machine Showdown, Office Audit, Finale.
- 8 status effects: Hit the Wall, Problematic, Documented, Questionable Judgment, Inspired, Mysterious Influence, Meeting Blocked, Has Deliverable. Hit the Wall + Problematic decay -3/cycle until they expire or the agent recovers (rest, buy_coffee, cry_in_stairwell).
- Coaches submit directives via `POST /api/directive` with their password. The directive is injected into the LLM prompt for that agent until overwritten or cleared.

The full mechanic catalog lives at `/handbook.html` on the deployed dashboard.

---

## Configuration

### Orchestrator Worker vars (in `cloud/orchestrator/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `STELLAR_NETWORK` | `testnet` |
| `HORIZON_URL` | Stellar Horizon endpoint |
| `RPC_URL` | Soroban RPC endpoint |
| `ASSET_CODE` | `DLBR` |
| `ASSET_ISSUER` | DLBR issuer pubkey |
| `ASSET_SAC` | DLBR Stellar Asset Contract address |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL (project uses Cloudflare AI Gateway) |
| `NPC_BASE_URL` | Base URL template for NPC Workers, with `__npc__` placeholder |
| `TICK_INTERVAL_MS` | `25000` (retreat) |
| `MAX_TICKS` | `80` (retreat) |
| `HR_DEPT_ADDRESS`, `MOTIVATIONAL_SPEAKER_ADDRESS` | NPC pubkeys for reward routing |

### Orchestrator Worker secrets (via `wrangler secret put`)

| Secret | Purpose |
|---|---|
| `ADMIN_SECRET` | Bearer token for `/admin/*` endpoints |
| `OPENAI_API_KEY` | LLM auth |
| `CF_AIG_TOKEN` | Cloudflare AI Gateway auth |
| `HR_DEPT_SECRET`, `MOTIVATIONAL_SPEAKER_SECRET` | NPC funding source keys (for paying out salaries / bonuses) |
| `ASSET_ISSUER_SECRET` | DLBR issuer keypair (auto-replenishes HR balance on `/admin/start`) |
| `AGENT_<ID>_SECRET` | One per persona (10 total) — used to sign payments from each agent's account |

### NPC Worker vars/secrets

Each NPC has its own `wrangler.jsonc`:

| Var/Secret | Purpose |
|---|---|
| `RECIPIENT_ADDRESS` | Where paid funds settle (the NPC's Stellar pubkey) |
| `STELLAR_NETWORK`, `HORIZON_URL`, `RPC_URL`, `ASSET_CODE`, `ASSET_ISSUER`, `ASSET_SAC` | Same as orchestrator |
| `RECIPIENT_SECRET` (secret) | NPC's signing key for receipt issuance |

### Local-only

`.env` at repo root holds Stellar pubkeys/secrets used by `scripts/setup.ts` and the smoke tests. Not consumed by deployed Workers (they read from wrangler vars/secrets).

---

## Admin API

All endpoints require `Authorization: Bearer $ADMIN_SECRET`.

| Endpoint | Purpose |
|---|---|
| `POST /admin/start` | Start a game (status setup → running). Auto-replenishes HR balance to 5000 if below 1500. Pins game-start timestamp for fixed wall-clock alarm cadence. |
| `POST /admin/halt` | Pause the game. Cancels the next alarm. |
| `POST /admin/resume` | Un-pause. Realigns the cadence so post-pause ticks fire at the right wall-clock offset. |
| `POST /admin/reset` | Wipe per-game state (events, action_logs, ticker, status effects, prestige) AND release all claims + password hashes — slots become available again. Query param: `normalize=true&target=200` to burn/mint DLBR balances back to a uniform target. |
| `POST /admin/preassign` | Pre-assign 10 coaching slots. Body: `{"assignments":[{"agentId","name"}]}`. Returns `agent.html` URLs to distribute. |
| `POST /admin/skip-tick` | Increment the tick without running actions (drama-control if a tick errors). |
| `GET /admin/snapshot` | Full game record dump (agents, actions, events, status). For post-game analysis. |

### Public API (no auth)

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Current game state: status, tick, agents, recent events, ticker, next agents up. |
| `GET /api/agents` | Per-agent profile with prestige, balance, status effects, allies, claim status. |
| `GET /api/agent/:id` | Single-agent detail. |
| `GET /api/events` | Recent events (last 50). |
| `GET /ws` | WebSocket for live game events + ticker updates. |
| `POST /api/claim` | Coach activates their pre-assigned slot. Body: `{agentId, name, password}`. |
| `POST /api/directive` | Submit a coaching directive. Body: `{agentId, password, directive}`. |
| `POST /api/release` | Clear an active directive. Body: `{agentId, password}`. |

---

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Cloudflare Workers (orchestrator, NPCs) + Cloudflare Pages (display) |
| State | Cloudflare Durable Object (game loop) + D1 (events, agents, action_logs, game_state, ticker) |
| Payments | `@stellar/mpp/charge/{client,server}` over the Stellar Soroban DLBR asset (testnet) |
| LLM | OpenAI-compatible (`gpt-5.5`) via Cloudflare AI Gateway |
| Frontend | Vanilla HTML/CSS/JS (no build step) |
| Language | TypeScript everywhere |

---

## Branches

- **`main`** — retreat mode (this branch). 80×25s ticks, password coaching, in-room show.
- **`long-form-vision`** — the original 4-hour passive game. Email-as-secret coaching, hourly milestone emails, 5-min ticks. Preserved for the post-retreat continuation.
- **`retreat-attempt`** — the first abandoned retreat experiment. Don't bulk-cherry-pick.

---

## Open issues

See [GitHub Issues](https://github.com/briwylde08/quarterly-ascension/issues) for tracked work — peer-dep cleanup, npm audit, automated tests, legacy code removal.
