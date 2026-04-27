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
  claimedBy: string | null;  // Player email
  claimedByName: string | null;  // Player name
}

export interface StatusEffect {
  type: StatusEffectType;
  expiresAtTick: number;
  source?: string;  // Agent ID or event name that caused it
}

export type StatusEffectType =
  | "tired"
  | "caffeinated"
  | "inspired"
  | "under_investigation"
  | "problematic"
  | "under_review"
  | "technical_difficulties"
  | "has_deliverable";

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
  | { type: "send_motivation"; target: string };

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

// Email report types
export interface HourlyReport {
  agentId: string;
  agentName: string;
  playerEmail: string;
  playerName: string;
  tickRange: [number, number];
  prestige: number;
  prestigeRank: number;
  budget: number;
  actions: ActionSummary[];
  rivals: string[];
  allies: string[];
  statusEffects: string[];
  notableQuotes: string[];
  complaints: ComplaintSummary[];
  transactions: TransactionSummary[];
}

export interface ActionSummary {
  tick: number;
  action: string;
  cost: number;
  outcome: string;
  quote: string;
}

export interface ComplaintSummary {
  type: "filed" | "received";
  counterparty: string;
  tick: number;
}

export interface TransactionSummary {
  tick: number;
  service: string;
  amount: number;
  txHash: string;
  explorerUrl: string;
}
