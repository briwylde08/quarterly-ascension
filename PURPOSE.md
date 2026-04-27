# Quarterly Ascension — Purpose & Direction

## What this is

A 2–4 hour live game where 10 players each get an AI middle-manager that autonomously climbs the corporate ladder at "MegaCorp Inc." Every 5 minutes, each manager decides what to do — buy coffee, file HR complaints, hire a consultant, sabotage a rival — and pays for it with a real USDC transaction on Stellar testnet. Players watch on a shared screen and get an hourly "performance review" email about their agent.

The point is to make agentic payments on Stellar feel **real and legible**, not abstract.

## Why it exists

The premise of agentic payments — AI agents settling money over HTTP without a human approving each transaction — is hard to sell with a slide deck. Most demos either (a) show one agent buying one thing, which is unconvincing, or (b) hide the payments behind a polished UX, which obscures the thing we're trying to show.

Quarterly Ascension is the opposite: a continuously-running economy where 10 agents make hundreds of real on-chain payments to each other and to NPC services, and you can see every single one settle in real time. By the end of a session, players have watched ~150 USDC transactions clear on Stellar without anyone clicking "approve."

The corporate-absurdist setting is doing real work. It makes the agents' reasoning entertaining ("Let's unpack this caffeine situation"), gives spectators a reason to care which payments happen, and turns the protocol mechanics into the punchline rather than hiding them.

## The load-bearing principle

> **If we have to choose between gameplay smoothness and visible protocol mechanics, we choose visibility.**

This is the one rule that resolves design arguments. Examples of what it means in practice:

- The payment ticker is a **first-class panel**, not an admin debug view. Every settlement shows up the moment it confirms, with the tx hash and elapsed time. People will stare at it during lulls.
- When an agent can't afford a forced payment, we let it hit Stellar and **fail visibly** (`op_underfunded`) rather than catching it in code. The network rejecting a payment is more convincing than our code rejecting it.
- Each NPC is a **separate HTTP service** that issues real `402 Payment Required` responses. We could collapse them into in-process function calls and the gameplay would be identical, but the protocol would be invisible.
- Hourly emails include **transaction links to stellar.expert**, not just summaries. The "holy shit it's actually real" moment happens when someone clicks one.

If a future change makes the game smoother but the payments less visible, push back.

## Who it's for

- **Players**: ~10 non-technical friends or coworkers, in the same room or on a call. They don't need wallets, don't sign anything, don't understand Stellar — they just pick a manager, watch, and get emails.
- **Spectators**: anyone in the room who isn't playing. The shared screen and ticker are designed for them.
- **The audience we're really making this for**: people who've heard "agentic payments" and aren't sure if it's real. After 30 minutes of watching, they should have stopped wondering.

## Why MPP Charge (and not the alternatives)

We evaluated three Stellar agentic payment protocols and chose MPP Charge mode:

| | Why it lost / won |
|---|---|
| **x402** | Requires a facilitator (OZ Channels) — third-party dependency we don't want during a live event. |
| **MPP Channel** | Off-chain commits batched until close. Faster, but spectators only see one settlement per session — kills the visibility principle. Also has Soroban storage TTL concerns over multi-hour sessions. |
| **MPP Charge** | No facilitator. Every payment is its own on-chain transaction, visible on stellar.expert in real time. Server can sponsor XLM fees so agents only need USDC. This is the one. |

For the scaled-up version (170+ agents, multi-day, microservices) the calculus might change. For 10 agents over an evening, Charge is the right answer.

## Scope: what's in, what's out

**In scope:**
- 10 agents, 7 NPC services, 5-minute ticks, ~48 ticks max
- Real USDC transactions on Stellar testnet
- LLM-driven decisions (Claude Haiku) constrained by per-agent personas and quirks
- Live shared screen with leaderboard, event feed, and payment ticker
- Hourly email "performance reviews" via Resend
- Admin halt/resume that preserves state
- Random events (12 of them) that add chaos
- Lightweight alliance system

**Explicitly out of scope (for now):**
- Real money. Testnet only. The whole demo works because nobody loses anything.
- Smart wallets / policy signers. The game server holds all 10 agent keys directly. This is fine because we trust ourselves to run the server, and a smart-wallet detour would delay the thing we're trying to show.
- Wallet connection (Freighter, etc.). Players don't sign anything — that's the point.
- A public API. NPC services are addressable on localhost; we're not letting third parties build agents against them.
- Bankruptcy mechanics beyond "broke agents can only take free actions." (Acquisition / subordination was discussed and deferred.)
- Mobile, replays, post-game interviews. Maybe a v2.
- Mainnet. Maybe later, with smart wallets, when the demo has earned that complexity.

These exclusions are decisions, not omissions. If something we cut shows up in scope creep, "we deliberately didn't" is the right reflex.

## What "it worked" looks like

A successful session has these moments:

1. Someone clicks a tx link in the ticker mid-game and goes to stellar.expert. They come back saying "wait, that's a real account."
2. During a lull, two players are both staring at the ticker watching pending payments resolve.
3. The first hourly email arrives. Someone laughs out loud and reads theirs aloud to the table.
4. By the end, the running total at the bottom of the screen reads something like "127 settlements · $1,847 USDC moved · avg 4.3s." Nobody had to be convinced this was real.

If those moments happen, the demo did its job. If players had fun but nobody noticed the payments, we got the priorities backwards.

## Open questions

These aren't blocking, but they'll need answers before the first real run:

- **Funding flow.** Agents currently have $0 testnet USDC. Circle's faucet is one-at-a-time; we either set a `FUNDING_ACCOUNT_SECRET` and re-run setup, or build a small batch funder.
- **LLM cost ceiling.** Claude Haiku is cheap, but 10 agents × 48 ticks × N retries can drift. Worth a hard budget cap.
- **Email throttling.** Resend free tier is 100 emails/day — fine for one session, but a day of testing could trip it.
- **Shared-screen format.** Web page on a TV is the assumption. Worth confirming venue/setup before tuning the layout.

## Where the design lives

- This file: high-level direction and principles.
- `README.md`: setup, ports, environment, run commands.
- `.session-2026-04-16.md`: the full design conversation that produced this. Goes deep on agent personas, NPC pricing, status effects, the agent decision loop, and the alternatives we considered and rejected. Search this when you want to know *why* something is the way it is.
