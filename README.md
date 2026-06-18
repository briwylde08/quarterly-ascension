# Quarterly Ascension

10 AI middle-managers compete for promotion to VP using real Stellar testnet payments via [MPP](https://github.com/stellar/mpp) (Machine Payments Protocol — Stellar's facilitator-free payment protocol for AI agents, using HTTP 402 for the handshake). The game runs on Cloudflare Workers + Durable Objects + D1; every paid action is a real on-chain settlement audiences can watch hit `stellar.expert` in real time.

> **Status:** public-playable. `main` is the 8-hour workday format — 60 ticks × 8 min each, **5-managers-per-tick** round-robin, self-serve "first claim opens a 30-min lobby" start, password-based coaching with a 5-step post-claim onboarding modal, in-page coaching hints, and 5 email updates per player (welcome + 3 progress + finale) via Cloudflare Email Sending. The `retreat` branch preserves the in-room live-show variant (25-second ticks, ~25 min runtime). The `long-form-vision` branch is the older 4-hour passive prototype (kept for archaeology, not deploy-ready).

---

## Architecture

```
┌──────────────────────────┐    WebSocket + REST    ┌────────────────────────┐
│  cloud/display/public    │ ─────────────────────▶ │  cloud/orchestrator    │
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

**Orchestrator** is a single Durable Object. It owns the alarm-driven tick loop, picks the next 5 agents per round-robin (half the roster per tick), calls the LLM for each agent's action choice, executes the action (which may include a real MPP payment to the corresponding NPC), persists everything to D1, and broadcasts state changes over WebSocket.

**NPCs** are stateless Workers. Each implements one or more paid endpoints via `@stellar/mpp/charge/server`'s `createCharge`. They return HTTP 402 with a payment challenge; the orchestrator's MPP client signs the auth entry, the payment settles on-chain, and the NPC returns the actual response.

**Display** is fully static HTML/CSS/JS hosted on Cloudflare Pages. It connects to the orchestrator's `/ws` endpoint for live updates and falls back to `/api/state` for bootstrap/refresh.

---

## Quick start (deploying from scratch)

You need: a Cloudflare account (Workers + Pages + D1 + Email Sending enabled), a Stellar testnet keypair to fund the asset issuer, and an OpenAI-compatible LLM endpoint (the project uses Cloudflare AI Gateway pointing at OpenAI's `gpt-5-mini`).

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

### 2b. Enable Cloudflare Email Sending

Email updates (claim confirmation, three progress reports, finale) ride the
Cloudflare `send_email` Workers binding. The sender domain must be onboarded
once before the first send:

```bash
npx wrangler email sending enable megacorp.lol
# follow the wrangler prompts to add the SPF/DKIM/DMARC DNS records
```

No `RESEND_API_KEY` or any other email provider key needed.

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

The public-playable flow is self-serve: the first person to claim a manager
opens a **30-minute lobby window**, and the game auto-starts when the window
closes. The host doesn't need to run anything to begin a round.

Players claim a manager via `/intro.html` → click through to `agent.html` →
type name + email + password → POST `/api/claim`. The first claim writes
`lobby_opened_at` and schedules the start alarm. Subsequent claims piggyback
on it. Players who arrive after the game starts see "claims closed."

Game length: 60 ticks × 8 min = 8 hours. Progress emails go out at ticks 15,
30, and 45; finale email when the game ends. Sixty minutes after the finale
the DO auto-resets and the next lobby opens.

Manual admin endpoints (gated by `ADMIN_SECRET`) remain as escape hatches:

```bash
ORCH=https://orchestrator.<your-subdomain>.workers.dev
ADMIN=<your ADMIN_SECRET>

# Force-start the game (skips the 30-min lobby — useful for testing)
curl -X POST "$ORCH/admin/start" -H "Authorization: Bearer $ADMIN"

# Halt / resume mid-game
curl -X POST "$ORCH/admin/halt"   -H "Authorization: Bearer $ADMIN"
curl -X POST "$ORCH/admin/resume" -H "Authorization: Bearer $ADMIN"

# Hard reset + normalize on-chain DLBR balances back to $200
curl -X POST "$ORCH/admin/reset?normalize=true&target=200" \
  -H "Authorization: Bearer $ADMIN"

# After a finished game: run the coach awards ceremony
curl -X POST "$ORCH/admin/judge-directives" -H "Authorization: Bearer $ADMIN"
```

The dashboard at `https://<your-pages-subdomain>.pages.dev` shows the
round-robin tick loop, paid actions settling on stellar.expert, and the
leaderboard updating live.

---

## Forking this repo

If you cloned this to run your own instance, several deployment-specific
strings are committed verbatim. Swap them for your own values before
deploying:

| Where | What | Notes |
|---|---|---|
| `cloud/orchestrator/wrangler.jsonc` | `database_id` (D1) | Create your own D1 via `npx wrangler d1 create <name>`; copy the new ID in. |
| `cloud/orchestrator/wrangler.jsonc` | `OPENAI_BASE_URL` | Embeds the account ID + AI Gateway slug. Create your own gateway under your CF account, swap the URL. |
| `cloud/orchestrator/wrangler.jsonc` | `NPC_BASE_URL` | `__npc__.<your-workers-subdomain>.workers.dev`. Workers subdomain is shown in the CF dashboard under Workers > Subdomain. |
| `cloud/orchestrator/wrangler.jsonc` | `ASSET_ISSUER` + `ASSET_SAC` | If you want your own DLBR variant; otherwise reuse these testnet contracts. |
| `cloud/orchestrator/wrangler.jsonc` | `HR_DEPT_ADDRESS` + `MOTIVATIONAL_SPEAKER_ADDRESS` | NPC funding-source public keys; generate via `scripts/create-issuer.ts` if you want fresh ones. |
| `cloud/orchestrator/src/email.ts` | `FROM_EMAIL` / `FROM_NAME` | `hr@megacorp.lol` — swap for an email address on a domain you've onboarded via `wrangler email sending enable`. |

None of the committed identifiers are credentials. Cloudflare requires an
API token for any account-level action, the AI Gateway rejects requests
without `CF_AIG_TOKEN`, and Stellar testnet addresses are public by design.
But if you fork and deploy without swapping these, your Worker would point
at the original author's gateway/NPC subdomain/D1 and fail at runtime.

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

## Game flow (public-playable mode)

- **60 ticks at 8 min each → ~8-hour game.** One full workday. Each of the 10 managers acts roughly **30 times** across the game.
- **5 managers act per tick**, picked from a stable randomized turn-order. Every 2 ticks (one roster pass, ~16 min), every manager has acted once. Cycle boundaries (every 5 ticks, ~40 min) trigger periodic mechanics (Synergy Dividend, random events, status decay, gossip refresh).
- Each agent's turn: LLM (`gpt-5-mini` via Cloudflare AI Gateway) picks an action from a 27-action menu, the orchestrator executes it. Paid actions trigger an MPP payment to the relevant NPC, settle on-chain via the Soroban DLBR contract, and the receipt + tx hash flow back into the dashboard ticker.
- **Fixed beats**:
  - Tick 1 — **Q1 Kickoff** (CEO speech + 10 per-agent reactions)
  - Tick 5 — **Cycle 1 closer** (guaranteed high-impact event)
  - Every cycle boundary (ticks 5, 10, 15, …) — **Synergy Dividend** (+$10/manager on-chain, keeps the economy solvent across the full 8-hour run)
  - Tick 15, 30, 45 — **Quarterly Bonuses** ($40/$25/$15 to top 3) + **progress emails** to claimed coaches
  - Tick 30-34 — **📋 Board Strategy Review** (every prestige change is doubled for 5 ticks; deterministic mid-game pivot)
  - Tick 60 — **Game End**, finale email to every coach, 60-min cleanup window, then auto-reset
- **Random events** roll probabilistically at each cycle boundary (one-per-game cap): Surprise Demo Day, Surprise Board Visit, Viral LinkedIn, Bad Glassdoor Review, Surprise Promotion, Budget Cuts, Printer Achieves Sentience, Quiet Quitting Memo Leaked, Vending Machine Showdown. Plus Glass Cliff Promotion (auto-fires when the leader is 50+ ahead of #2).
- **Status effects**: Hit the Wall (-3/cycle, cured by buy_coffee / shotgun_red_bull / cry_in_stairwell), Problematic, Documented (next take_credit against you auto-succeeds), Questionable Judgment, Mysterious Influence (+2/cycle passive), Meeting Blocked, Has Deliverable, HR Audit (locks take_credit for 8 ticks after 2 successful Take Credits in 8 ticks), Board Strategy Review (all-agents, ticks 30-34, prestige doublings).
- **`take_credit` cap**: each agent can use Take Credit at most **4 times per game**. Prevents the sabotage→take_credit chain from dominating play.
- **Lobby auto-start**: the first claim opens a 30-minute lobby. Subsequent claims piggyback. When the lobby alarm fires, the game auto-starts with whatever claims are in (uncoached managers play autonomously). The lobby-opener can skip the wait with their password via the inline form on `intro.html`.
- **Coaching**: a coach claims a manager via `/intro.html` (name + email + password). After claim success, a 5-step onboarding modal walks them through the game flow, coaching mechanics, and the four pages they'll use. They submit directives any time during a running game via `POST /api/directive` with their password. The directive is injected into the LLM prompt for that agent until overwritten or `DELETE`'d. The dashboard surfaces a "Considered / Pending" pill on the character page so coaches know when their directive has been read.
- **Coaching hints**: agent.html shows two-tier suggestions above the directive box — **⚡ Suggested Actions** (2 atomic plays, click-to-pre-fill chips) and **🎯 Strategic Directives** (3-4 multi-turn combo hints). Picked server-side by the `/api/coaching-hints` endpoint based on the manager's live state.
- **Email cadence** (Cloudflare Email Sending, sender `hr@megacorp.lol`): claim confirmation, progress reports at ticks 15/30/45, finale at tick 60.
- **Per-coach view**: opening the dashboard with `?coach=<agentId>` highlights events and the leaderboard row for that manager with a gold `🎙 YOURS` pill.
- **Coach Alignment Leaderboard**: on `/directives.html`, ranks every claimed manager by how often they followed / tilted / defied their coach. Powered by `/api/coach-alignment`, computed from `action_logs.directive_alignment`.
- **Post-game awards**: `POST /admin/judge-directives` hands every directive snapshot to an LLM judge that picks winners in four categories (Most Entertaining, Most Committed to Character, Best Single Directive, Most Chaotic). The host opens `/awards.html` to project the ceremony.

The full mechanic catalog lives at `/handbook.html` on the deployed dashboard.

---

## Configuration

### Orchestrator Worker vars (in `cloud/orchestrator/wrangler.jsonc`)

| Var | Purpose |
|---|---|
| `STELLAR_NETWORK` | `testnet` |
| `HORIZON_URL` | Stellar Horizon endpoint |
| `ASSET_CODE` | `DLBR` |
| `ASSET_ISSUER` | DLBR issuer pubkey |
| `ASSET_SAC` | DLBR Stellar Asset Contract address |
| `OPENAI_BASE_URL` | OpenAI-compatible base URL (project uses Cloudflare AI Gateway → `gpt-5-mini`) |
| `NPC_BASE_URL` | Base URL template for NPC Workers, with `__npc__` placeholder |
| `TICK_INTERVAL_MS` | `480000` (8-min ticks for the 8-hour public-playable format) |
| `MAX_TICKS` | `60` |
| `LOBBY_DURATION_MS` | `1800000` (30-min lobby window between first claim and game auto-start) |
| `HR_DEPT_ADDRESS`, `MOTIVATIONAL_SPEAKER_ADDRESS` | NPC pubkeys for reward routing |

### Orchestrator Worker bindings

| Binding | Type | Purpose |
|---|---|---|
| `ORCHESTRATOR` | Durable Object | The single `GameOrchestrator` instance that owns the tick loop |
| `DB` | D1 | `events`, `agents`, `action_logs`, `game_state`, `ticker`, `leaked_emails` |
| `EMAIL` | `send_email` | Cloudflare Email Sending for claim confirmation + progress + finale emails. Sender domain must be onboarded via `wrangler email sending enable <domain>` |

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
| `POST /admin/start` | Start a game (status setup → running) — skips the 30-min lobby. Auto-replenishes HR balance to 5000 if below 1500. Pins game-start timestamp for fixed wall-clock alarm cadence. |
| `POST /admin/halt` | Pause the game. Cancels the next alarm. |
| `POST /admin/resume` | Un-pause. Realigns the cadence so post-pause ticks fire at the right wall-clock offset. |
| `POST /admin/end` | End the running game (status running → ended). Triggers the post-game cleanup alarm. |
| `POST /admin/tick` | Manually fire one tick (debugging / drama-control). |
| `POST /admin/reset` | Wipe per-game state (events, action_logs, ticker, status effects, prestige) AND release all claims + password hashes. Two-pass normalize: query param `normalize=true&target=200` burns/mints DLBR balances back to a uniform target with a settle-wait between passes so in-flight Stellar settlements are caught. |
| `POST /admin/normalize` | Run the two-pass balance normalization without resetting other state. Query: `target=200`. |
| `POST /admin/cancel-cleanup` | Cancel the pending post-game cleanup alarm so a `/admin/snapshot` or `/admin/judge-directives` can still run after game-end. |
| `POST /admin/judge-directives` | Hand all coached directives to an LLM judge and return 4 awards (Most Entertaining / Most Committed / Best Single / Most Chaotic). Use `/awards.html` to project. |
| `POST /admin/test-email` | Debug-only: send a test email via the `EMAIL` binding to verify Cloudflare Email Sending end-to-end. Body: `{"to": "addr@example.com"}`. |
| `GET /admin/snapshot` | Full game record dump (agents, actions, events, status). For post-game analysis. |
| `GET /admin/status` | Quick game-state probe (status, tick, alarm). |

### Public API (no auth)

| Endpoint | Purpose |
|---|---|
| `GET /api/state` | Current game state: status, tick, agents, recent events, ticker, next agents up, turn order, lobby state (`lobbyOpenedAt`, `lobbyOpenedBy`, `lobbyDurationMs`). |
| `GET /api/agents` | Per-agent profile with prestige, balance, status effects, allies, claim status. |
| `GET /api/agent/:id` | Single-agent detail including recent actions and inbound events targeting them. |
| `GET /api/events` | Recent events (last 50). |
| `GET /api/relationships` | Current alliances + recent rivalries (agents who've attacked each other 2+ times in last 12 ticks). |
| `GET /api/gossip` | Rolling LLM-narrated summary of big moments from the last cycle. |
| `GET /api/coaching-hints?agentId=<id>` | Returns `{ suggestedActions: [...], strategicDirectives: [...] }` — server-picked coaching suggestions based on the manager's live state. Drives the hint chips on `agent.html`. |
| `GET /api/coach-alignment` | Returns `{ board: [...] }` — per-coach followed/tilted/defied counts + percentage. Powers the Coach Alignment Leaderboard on `directives.html`. |
| `GET /ws` | WebSocket for live game events + ticker updates. |
| `POST /api/claim` | Claim a manager: atomic agent-update + password-write inside a D1 batch. Body: `{agentId, name, email, password}`. Refused unless status='setup'. First claim writes `lobby_opened_at` + `lobby_opened_by` and schedules the auto-start alarm. |
| `POST /api/start-game` | Skip the 30-min lobby wait — only callable by the lobby opener with their claim password. Body: `{agentId, password}`. |
| `POST /api/directive` | Submit a coaching directive. Body: `{agentId, password, directive}`. 280-char cap. |
| `DELETE /api/directive` | Clear the active directive. Body: `{agentId, password}`. |
| `POST /api/release` | Release a claimed manager so someone else can claim them. Body: `{agentId, password}`. Refused while game is running. |

---

## Tech stack

| Layer | Tech |
|---|---|
| Runtime | Cloudflare Workers (orchestrator, NPCs) + Cloudflare Pages (display) |
| State | Cloudflare Durable Object (game loop) + D1 (events, agents, action_logs, game_state, ticker, leaked_emails) |
| Payments | `@stellar/mpp/charge/{client,server}` over the Stellar Soroban DLBR asset (testnet). `sendAsset` retries on transient testnet failures with 1.5s + 3s backoff. |
| LLM | OpenAI-compatible (`gpt-5-mini`) via Cloudflare AI Gateway. `reasoning_effort: "low"` on the action picker, `"minimal"` on the gossip narrator. |
| Email | Cloudflare Email Sending via the `EMAIL` binding. Claim confirmation + progress (ticks 15/30/45) + finale (tick 60). |
| Frontend | Vanilla HTML/CSS/JS (no build step) |
| Language | TypeScript everywhere |

---

## Branches

- **`main`** — public-playable. The 8-hour-workday format: 60 ticks × 8 min, 5 managers/tick, self-serve "first claim opens a 30-min lobby" auto-start, password-based coaching, 5 emails per coach via Cloudflare Email Sending, on-chain DLBR settlements throughout. This is the deployable branch.
- **`retreat`** — preserved snapshot of the in-room live-show variant used at the SDF retreat (May 2026): 25-second ticks, 2 managers/tick, ~25 min runtime, no email, manual host start. Kept for historical reference.
- **`long-form-vision`** — the original pre-pivot prototype: 4-hour passive game, 5-min ticks, email-as-secret coaching. Kept for archaeology, not deploy-ready.

---

## Open issues

See [GitHub Issues](https://github.com/briwylde08/quarterly-ascension/issues) for tracked work — peer-dep cleanup, npm audit, automated tests, legacy code removal.
