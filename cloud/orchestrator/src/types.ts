// Game state types

export type GameStatus = "setup" | "running" | "halted" | "ended";

export interface Agent {
  id: string;
  personaId: string;
  name: string;
  title: string;
  publicKey: string;
  secretKey: string;
  prestige: number;
  statusEffects: StatusEffect[];
  allies: string[];       // Agent IDs
  pendingAlliance: string | null;  // Agent ID who proposed
  /** Legacy email column from the long-form claim flow. Always NULL in
   *  retreat mode — auth is password-based; the password hash lives in
   *  game_state under password_<agentId>. Kept on the Agent type so the
   *  DB row mapper stays simple. */
  claimedBy: string | null;
  claimedByName: string | null;  // Player name (set at /api/claim)
}

export interface StatusEffect {
  type: StatusEffectType;
  expiresAtTick: number;
  source?: string;  // Agent ID or event name that caused it
}

export type StatusEffectType =
  // Retreat-mode keys (internal stable strings; user-facing labels are
  // applied in the LLM/dashboard formatters):
  //   "tired" displays as "Hit the Wall"
  //   "marked" displays as "Documented"
  | "tired"
  | "caffeinated"
  | "inspired"
  | "under_investigation"
  | "problematic"
  | "under_review"
  | "technical_difficulties"
  | "has_deliverable"
  | "mandatory_motivation"
  | "meeting_blocked"
  /** Sabotage_plan paints a target — take_credit against them auto-succeeds. */
  | "marked"
  /** Acquired after 3× join_meeting_silently. +2 prestige/cycle passive +
   *  10% chance another agent's reasoning credits the holder for their own action. */
  | "mysterious_influence"
  /** Spread_rumor leaves the target with a public credibility tag. */
  | "questionable_judgment";

export interface ActionResult {
  success: boolean;
  action: Action;
  outcome: string;
  prestigeChange: number;
  txHash?: string;
  settlementTime?: number;
  error?: string;
}

export type Action =
  | { type: "work" }
  | { type: "rest" }
  | { type: "schmooze"; target: string }
  | { type: "take_credit"; target: string }
  | { type: "accept_alliance"; target: string }
  | { type: "reject_alliance"; target: string }
  | { type: "break_alliance"; target: string }
  | { type: "buy_coffee" }
  | { type: "buy_fancy_coffee" }
  | { type: "file_complaint"; target: string }
  | { type: "sensitivity_training"; target: string }
  | { type: "check_hr_status" }
  | { type: "strategy_report" }
  | { type: "competitive_intel" }
  | { type: "sabotage_plan"; target: string }
  | { type: "fix_laptop"; target: string }
  | { type: "recover_emails"; target: string }
  | { type: "calendar_conflict"; target: string }
  | { type: "book_ceo_time" }
  | { type: "leak_org_chart" }
  | { type: "schedule_conflict"; target: string }
  | { type: "team_lunch" }
  | { type: "poison_meeting"; target: string }
  | { type: "birthday_cake" }
  | { type: "book_motivation" }
  | { type: "send_motivation"; target: string }
  | { type: "whistleblower_bounty"; target: string }
  | { type: "mentorship"; target: string }
  | { type: "coffee_chat"; target: string }
  | { type: "hail_mary_idea" }
  | { type: "expense_report" }
  // === Retreat-mode additions (handlers in tick.ts land in #87) ===
  | { type: "spread_rumor"; target: string }
  | { type: "move_meeting_early"; target: string }
  | { type: "schedule_pre_meeting"; target: string }
  | { type: "office_party" }
  | { type: "anonymous_pulse_survey"; target: string }
  | { type: "hostile_takeover"; target: string }
  | { type: "boomerang" }
  | { type: "cry_in_stairwell" }
  | { type: "join_meeting_silently" }
  | { type: "slack_bomb"; target: string }
  | { type: "invoke_handbook"; target: string };

export interface GameEvent {
  id: string;
  tick: number;
  timestamp: Date;
  type: GameEventType;
  agentId?: string;
  targetId?: string;
  description: string;
  prestigeChange?: number;
  txHash?: string;
  settlementTime?: number;
  reasoning?: string;  // In-character LLM justification, surfaced in the event feed
  /** Multi-agent random events emit a parent "header" event plus child
   *  events nested under it on the dashboard. Children carry parentEventId
   *  pointing back to the parent so the renderer can group them. */
  parentEventId?: string;
  /** Set on type='action' / 'payment' events so the dashboard can render
   *  action-aware narrative headers ("Kevin went to HR and spread a rumor
   *  about Diane") instead of the generic "Actor → Service" line. */
  actionType?: string;
  /** Display name of the target agent (when the action has one). Resolved
   *  server-side so the dashboard doesn't need a separate name lookup. */
  targetName?: string;
  /** Optional action-specific narrative detail (e.g. the title of a
   *  consultant report) so the dashboard can produce headers like
   *  "got a report titled 'Disruptive Alignment Strategy'" without
   *  needing to parse the description string. */
  actionDetail?: string;
}

export type GameEventType =
  | "action"
  | "payment"
  | "payment_failed"
  | "alliance_formed"
  | "alliance_broken"
  | "alliance_rejected"
  | "random_event"
  | "status_effect"
  | "game_start"
  | "game_end"
  | "game_halted"
  | "game_resumed";

export interface RandomEvent {
  id: string;
  name: string;
  description: string;
  probability: number;  // Per tick, 0-1
  effect: (gameState: GameState) => Promise<GameEvent[]>;
}

export interface TickerEntry {
  id: string;
  fromAgent: string;
  fromAgentName: string;
  toService: string;
  amount: number;
  status: "pending" | "submitted" | "settled" | "failed";
  txHash?: string;
  submittedAt?: number;
  settledAt?: number;
  settlementTime?: number;
  error?: string;
  reasoning?: string;  // In-character LLM reasoning for the action that triggered this payment
}

export interface GameState {
  status: GameStatus;
  currentTick: number;
  startedAt: Date | null;
  agents: Map<string, Agent>;
  events: GameEvent[];
  ticker: TickerEntry[];
  totalTransactions: number;
  totalUsdcMoved: number;
  averageSettlementTime: number;
}

export interface NpcService {
  id: string;
  name: string;
  port: number;
  publicKey: string;
  secretKey: string;
  endpoints: NpcEndpoint[];
}

export interface NpcEndpoint {
  path: string;
  method: "GET" | "POST";
  price: number;  // In DLBR (e.g., 8 = $8)
  description: string;
  effect: string;
}

