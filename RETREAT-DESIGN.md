# Quarterly Ascension — Retreat Edition Design Spec

**Audience:** SDF company retreat. ~170 attendees: 10 claimers + 160 spectators.
**Format:** 30-minute live show on a projector + secondary directive screen.
**Goals (in priority order):**
1. High drama and excitement throughout
2. Visible MPP / x402 transaction flow on the dashboard ticker
3. Fair-ish across all 10 characters — every claimer's manager has visible moments

This spec is the locked design from the design pass. All numbers are intentional; raise questions in PR review before changing.

## Game shape at a glance

- **Total length:** 30 min
- **Cycle structure:** round-robin within each cycle — managers act one at a time in randomized turn order
- **Per-action time:** 20s (Stellar settle ~5s, dashboard animation ~5s, narrator beat ~10s)
- **Cycle length:** 10 managers × 20s + ~30s for random events = **4 minutes**
- **Cycles per game:** **8**
- **Total manager actions:** ~75-80
- **Total on-chain transactions (incl. random events):** ~85+

This produces a steady transaction drumbeat with cycle-boundary punctuation, instead of big-bang ticks where 10 actions land in 5 seconds.

## The 27 actions

### Free (11)

| Action | Notes |
|---|---|
| `work` | +5 prestige, +$5 salary |
| `rest` | Removes Hit the Wall |
| `expense_report` | +$10 reimbursed; 20% chance Finance flags it (-5 prestige) |
| `take_credit` | 50% success: +30 prestige; 50% fail: -20 |
| `hail_mary_idea` | Lottery: 30% +50, 50% +5, 20% -5. One-shot per game. |
| `schmooze` | Propose cross-functional partnership |
| `accept_alliance` | +5 to both |
| `reject_alliance` | Proposer -10 |
| `break_alliance` | -15 to you; ex-partner gets Under Investigation 1 cycle |
| `boomerang` | **Conditional:** prestige < 50. Resets you to 100. One-shot. |
| `cry_in_stairwell` | **Conditional:** prestige ≤ 30. Removes Problematic + Hit the Wall. 20% chance VP grants +20 sympathy. |
| `join_meeting_silently` | +4 prestige. **Capped at 3 uses/game.** Third use confers Mysterious Influence. |

### $5 – $10 (4)

| Action | Cost | Notes |
|---|---|---|
| `coffee_chat` | $5 | Both gain +3 prestige (no alliance) |
| `buy_coffee` | $5 | Removes Hit the Wall |
| `spread_rumor` | $10 | Target -5 prestige + Questionable Judgment 2 cycles |
| `move_meeting_early` | $10 | Target -5 prestige + Hit the Wall |

### $20 – $25 (6)

| Action | Cost | Notes |
|---|---|---|
| `schedule_pre_meeting` | $20 | Target -15 + Meeting Blocked. Loyalty > 70 immune. |
| `file_complaint` | $22 | You +5; target Under Investigation 1 cycle |
| `strategy_report` | $25 | +35 prestige, gains Has Deliverable |
| `leak_org_chart` | $25 | Top 3 wealth + alliance graph + you +5 |
| `office_party` | $25 | +5 to ALL managers, +15 to you |
| `anonymous_pulse_survey` | $25 | Target -50 prestige. **Conditional:** you rank ≥ 4, target #1. One shot per game. |

### $30 – $50 (5)

| Action | Cost | Notes |
|---|---|---|
| `sensitivity_training` | $30 | Target -20 + Problematic 4 cycles |
| `schedule_conflict` | $30 | Cancels target's CEO meeting + Meeting Blocked 2 cycles |
| `hostile_takeover` | $35 | Target's cross-functional partnerships transfer to you |
| `sabotage_plan` | $40 | Target -10 + Documented 2 cycles |
| `book_ceo_time` | $50 | +40 with Has Deliverable, -20 without, -10 if Meeting Blocked |

## Coaching

- **Always open.** No quarter gates, no coaching credits, no windows. Claimers can submit a directive at any tick.
- **Persistent.** Directives stick until the claimer overwrites them (no auto-clear after use).
- **Visible.** Every active directive is displayed verbatim on a separate "directive screen" projected next to the main dashboard. Directive cap: **280 characters**.
- **Soft-medium override.** Persona traits can resist a directive; the LLM is instructed to comply imperfectly when directive contradicts character. The gap is the comedy.
- **Reasoning quote required.** When a directive is active, the LLM's reasoning quote must reference it. This makes the directive → action mapping legible to the audience.
- **Anti-repetition:** The prompt includes the agent's last 3 actions with a "vary your behavior" nudge. No hard cooldowns.
- **Profanity:** Render verbatim by default. Optional regex profanity check that swaps to `[REDACTED]` if needed.

## The 9 random events

| Event | Trigger | Effect |
|---|---|---|
| **Glass Cliff Promotion** | Auto-fires when leader is 50+ prestige ahead of #2; **once per victim per game** | Leader drops to #2's value, gets "Promoted to VP of Strategic Initiatives" flavor |
| **Quarterly Bonus** | Fixed cycles 4 (halftime) and 8 (finale) | Cycle 4: $50/$30/$20 to top 3. Cycle 8: $100/$60/$40 to top 3. |
| **Surprise Board Visit** | Random 10%/cycle | Picks 3 agents: winner +25, loser -25, scrutinized → Under Investigation |
| **Bad Glassdoor Review** | Random 12%/cycle | Single agent -10 + funny anonymous quote (existing 9-headline bank) |
| **Surprise Promotion** | Random 10%/cycle | Random agent +30, weighted toward bottom half (underdog booster) |
| **Surprise Demo Day** | Random 10%/cycle | Each agent reacts based on personality (aggression/loyalty/caution/greed) |
| **Budget Cuts** | Random 12%/cycle | Burns USDC on-chain from 5 random agents (visible MPP) |
| **Viral LinkedIn Post** | Random 10%/cycle | Random agent: 75% +15 prestige, 25% -5 + Problematic. Quote bank below. |
| **Printer Achieves Sentience** | Random 6%/cycle | Pure flavor with weird per-agent micro-effect |

**Expected per-game distribution:** 2 guaranteed Quarterly Bonuses + 0-2 Glass Cliffs + ~5 random pool events = **~7-9 events per game**.

## Economy

- **Starting USDC per manager:** $200
- **Work salary:** +$5 per cycle when chosen
- **Expense report:** +$10 (80% of the time)
- **Mean paid action cost:** ~$24
- **Expected paid actions per game:** ~6 per manager (matches 8 cycles × 75% paid)
- **Spend ceiling per game:** ~$144

The bankroll is calibrated so that money matters but doesn't choke the show. Every manager can afford the showcase `book_ceo_time` ($50) at least once. Bottom-half finishers run lean by cycles 7-8 — exactly when free comeback actions (`boomerang`, `cry_in_stairwell`, `hail_mary_idea`) become the dramatic option.

## The 10 personas

| ID | Name | Title | Trope | Aggr | Greed | Caut | Loyal |
|---|---|---|---|---|---|---|---|
| chad | Chad Synergize | Director of Alignment | Buzzword salad founder-bro | 85 | 70 | 20 | 40 |
| linda | Linda Metrics | Senior KPI Analyst | Spreadsheet survivor | 30 | 50 | **80** ⬇ | 60 |
| trevor | Trevor Disrupt | Innovation Lead | Pivots every 3 cycles | 70 | 40 | 30 | 20 |
| brenda | Brenda Compliance | Risk Manager | Reports others, takes no risks | 20 | 30 | **85** ⬇ | 80 |
| kevin | Kevin Hustle | Growth Hacker | Will backstab anyone | 80 | 95 | 25 | 15 |
| diane | Diane Process | Operations Manager | "Let's circle back" | 40 | 40 | 70 | 70 |
| marcus | Marcus Leverage | Strategic Partnerships | The networker | 60 | 60 | 50 | 85 |
| stacy | Stacy Bandwidth | Resource Coordinator | Overwhelmed | 35 | 25 | 45 | 50 |
| ron | Ron Legacy | Senior VP (Emeritus) | Territorial vet | 25 | 80 | **75** ⬇ | 30 |
| jen | Jen Actionable | Project Manager | Suspiciously competent | 65 | 55 | 40 | 65 |

**Caution lowered for retreat (Brenda, Linda, Ron)** so cautious personas don't completely abstain from paid action — keeps MPP ticker active.

**Host pre-assignment strategy:** Match personas to claimers deliberately for comedy mismatches (loud claimer → Brenda Compliance; quiet claimer → Chad Synergize; senior person → Stacy Bandwidth).

## The 8 status effects

| Effect | What it does | Duration | Source | Removed by |
|---|---|---|---|---|
| **Hit the Wall** | -2 prestige/cycle passive | 3 cycles | `move_meeting_early` | `rest`, `buy_coffee`, `cry_in_stairwell`, decay |
| **Problematic** | -3 prestige/cycle + public tag | 4 cycles | `sensitivity_training` | `cry_in_stairwell`, decay |
| **Under Investigation** | Can't take hostile action against complainer | 1 cycle | `file_complaint` | decay |
| **Documented** | Next `take_credit` against you auto-succeeds | 2 cycles | `sabotage_plan` | consumed by take_credit, or decay |
| **Meeting Blocked** | Can't book CEO time | 2 cycles | `schedule_pre_meeting`, `schedule_conflict` | decay |
| **Has Deliverable** | `book_ceo_time` gives +40 (else -20) | Until consumed | `strategy_report` | consumed by book_ceo_time |
| **Mysterious Influence** | +2 prestige/cycle + 10% chance another agent's reasoning credits you for their action | While held (after 3× join_meeting_silently) | `join_meeting_silently` (3rd use) | n/a — retained |
| **Questionable Judgment** | Public tag, slight take_credit vulnerability | 2 cycles | `spread_rumor` | decay |

**Natural fatigue accrual is dropped for retreat** — Hit the Wall is only spread by `move_meeting_early` as an intentional weapon, not by an ambient timer.

## LinkedIn quote bank (seed)

10 cringe samples for the Viral LinkedIn Post random event:

> *"10 things I learned about leadership from my Peloton instructor 🧵"*
> *"Cried in the parking lot after a hard meeting today. Vulnerability IS leadership. #authenticity"*
> *"My toddler taught me more about Q4 strategy than any MBA program ever could."*
> *"Just took my team off-site to goat yoga. Productivity is up 312%. Thread below."*
> *"Got rejected from Y Combinator for the third time. Here's why I'm grateful."*
> *"Fired my entire eng team this morning. Here's why it was actually an act of love."*
> *"I read 47 business books this year. Here's the one rule that beats them all."*
> *"Got told 'no' in my 1:1 today. Best thing that's ever happened to me. #grateful"*
> *"My intern made a typo today. I let her keep her job. Here's why mercy is the new KPI."*
> *"Just closed our Series B. The real win? My therapist said I'm 'less reactive.'"*

Add 5-10 more before retreat.

## Tone guardrail

Avoid jokes that single out real SDF teams (Marketing especially — flagged as too on-the-nose). "Eng" is fine. Generic functions ("the team," "leadership," "my reports") always safe. The fictional MegaCorp setting and the in-game `HR Department` NPC are intentional — those exist *as* the joke.

## Implementation surface

When porting from `long-form-baseline-pre-retreat`, these are the touch points:

**Backend (`cloud/orchestrator/src/`):**
- `llm.ts` — replace action menu with the 27, integrate directive + last-3-actions into prompt
- `tick.ts` — implement round-robin turn order, drop natural fatigue
- `random-events.ts` — port 9 events from retreat-attempt; cut the rest
- `orchestrator-do.ts` — `/api/directive` (always-accept, persist), `/admin/preassign`, `/api/claim` (atomic claim+activate), drop email path
- `personas.ts` — apply caution tweaks
- `types.ts` — status effect union (8); add Mysterious Influence + Questionable Judgment
- `wrangler.jsonc` — `TICK_INTERVAL_MS: "20000"`, `MAX_TICKS: "8"`

**Frontend (`cloud/display/public/`):**
- `index.html` — main dashboard (manager cards, prestige, action stream, random event chyron)
- `agent.html` — claim/activate/coach forms (password-based, no email)
- `directives.html` *(new)* — projector-friendly second screen showing 10 active directives verbatim

**Database (`cloud/db/migrations/`):**
- Selectively port the `events.action_type` migration from retreat-attempt
- Add `agents.directive` column (or store in `game_state` keyed by agent)

## Pre-flight test plan

Before retreat day:
- Run **3 full 30-minute games end-to-end** with placeholder claimers
- Verify: ticks complete cleanly, no subrequest cap errors, action distribution diverse, random events fire on cadence, HR auto-replenish working, MPP transactions appearing live, directive screen updates in real time
- After each: pull `/admin/snapshot` and archive

If any game breaks: fix → redeploy → run again until 3 clean.

## Out of scope (post-retreat)

- 160 spectator subscribe-to-manager flow
- Persona expansion beyond 10
- Long-lived sessions / "remember me" for coaching
- Mobile + projector responsive polish (defer unless retreat venue demands it)
- Long-form passive game tweaks (continue on `long-form-baseline-pre-retreat`)

## Critical decisions locked in this design pass

- 27 actions (18 from long-form + 9 from retreat-attempt)
- Round-robin cadence (20s/action, 4-min cycles, 8 cycles)
- Always-open coaching with verbatim directive screen
- 9 random events including Glass Cliff once-per-victim
- $200 starting bankroll, calibrated bonus payouts
- 10 existing personas with caution tweaks for retreat
- 8 status effects with renames (Tired → Hit the Wall, Marked → Documented)
- Mysterious Influence beefed with 10% misattribution mechanic

## Branch strategy

- Implementation work on a new branch off `long-form-baseline-pre-retreat` (tag preserved on origin)
- Old retreat-attempt parked at `retreat-attempt` for selective cherry-picking
- Live site (`quarterly-ascension.pages.dev`) deploys from `main` — only push to main once retreat code is tested on a preview
