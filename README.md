# Quarterly Ascension

AI middle-managers compete for VP using real Stellar payments via MPP.

## Quick Start

```bash
# Install dependencies
npm install

# Copy environment file and fill in your keys
cp .env.example .env

# Set up testnet accounts (creates 10 agents + 7 NPCs)
npm run setup

# Start NPC services (in one terminal)
npm run services

# Start the game (in another terminal)
npm start
```

## How It Works

10 AI agents with distinct personalities compete over 2-4 hours to become VP. Every 5 minutes, each agent:

1. Observes their situation (prestige, budget, rivals, allies)
2. Decides on an action (LLM-powered, in character)
3. Executes the action, which may involve a real Stellar payment

All payments use **MPP (Machine Payments Protocol)** on Stellar testnet:
- NPCs return 402 Payment Required
- Agents sign auth entries and pay
- Transactions settle on-chain in ~5 seconds
- Every payment is visible on stellar.expert

## Components

- **Orchestrator** (`:3000`) - Main game server, tick loop, admin API
- **Display** (`:3001`) - Shared screen with leaderboard and payment ticker
- **NPC Services** (`:3010-3016`) - 7 paid services that accept MPP payments

## NPC Services

| Service | Port | What They Sell |
|---------|------|----------------|
| Coffee Cart | 3010 | Productivity boosts |
| HR Department | 3011 | File complaints, sensitivity training |
| The Consultant | 3012 | Strategy reports, competitive intel |
| IT Guy | 3013 | "Fix" laptops, recover emails |
| Executive Assistant | 3014 | CEO time, org chart leaks |
| The Caterer | 3015 | Team lunches, birthday cakes |
| Motivational Speaker | 3016 | Inspiration sessions |

## Admin API

```bash
# Check status
curl http://localhost:3000/health

# Halt game
curl -X POST http://localhost:3000/admin/halt \
  -H "Authorization: Bearer $ADMIN_SECRET"

# Resume game
curl -X POST http://localhost:3000/admin/resume \
  -H "Authorization: Bearer $ADMIN_SECRET"

# End game
curl -X POST http://localhost:3000/admin/end \
  -H "Authorization: Bearer $ADMIN_SECRET"
```

## Environment Variables

```
# Stellar
STELLAR_NETWORK=testnet

# LLM
ANTHROPIC_API_KEY=sk-ant-...

# Email
RESEND_API_KEY=re_...

# Admin
ADMIN_SECRET=your-secret

# Game
TICK_INTERVAL_MS=300000  # 5 minutes
MAX_TICKS=48             # 4 hours
STARTING_BUDGET=500      # $500 USDC per agent
```

## Display

Open `http://localhost:3001` to see:
- Live leaderboard
- Event feed
- Payment ticker (every settlement with tx hash and timing)
- Running totals

## Hourly Reports

Players receive email reports every hour showing:
- Their agent's actions
- Prestige changes
- Transaction links
- Notable quotes from their agent's reasoning

## Tech Stack

- TypeScript / Node.js
- Express
- MPP (@stellar/mpp)
- Stellar SDK
- SQLite
- Claude Haiku (decisions)
- Resend (emails)
- WebSocket (real-time display)
