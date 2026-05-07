// D1-binding-backed query helpers. Same surface as src/lib/db.ts on the
// laptop side, but every call uses the env.DB binding (no HTTP round-trip),
// which is one of the main wins of moving the orchestrator into a DO.

import type { Agent, GameEvent, StatusEffect, TickerEntry, GameStatus } from "./types.js";

export class Db {
  constructor(private readonly db: D1Database) {}

  // game_state
  async getGameStatus(): Promise<GameStatus> {
    const row = await this.db
      .prepare("SELECT value FROM game_state WHERE key = 'status'")
      .first<{ value: string }>();
    return (row?.value as GameStatus) || "setup";
  }

  async setGameStatus(status: GameStatus): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO game_state (key, value) VALUES ('status', ?)")
      .bind(status)
      .run();
  }

  async getCurrentTick(): Promise<number> {
    const row = await this.db
      .prepare("SELECT value FROM game_state WHERE key = 'current_tick'")
      .first<{ value: string }>();
    return row ? parseInt(row.value, 10) : 0;
  }

  async setCurrentTick(tick: number): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO game_state (key, value) VALUES ('current_tick', ?)")
      .bind(tick.toString())
      .run();
  }

  // agents
  async saveAgent(agent: Agent): Promise<void> {
    await this.db
      .prepare(
        `INSERT OR REPLACE INTO agents
           (id, persona_id, name, title, public_key, secret_key, prestige, status_effects, allies, pending_alliance, claimed_by, claimed_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        agent.id,
        agent.personaId,
        agent.name,
        agent.title,
        agent.publicKey,
        agent.secretKey,
        agent.prestige,
        JSON.stringify(agent.statusEffects),
        JSON.stringify(agent.allies),
        agent.pendingAlliance,
        agent.claimedBy,
        agent.claimedByName
      )
      .run();
  }

  async getAgent(id: string): Promise<Agent | null> {
    const row = await this.db
      .prepare("SELECT * FROM agents WHERE id = ?")
      .bind(id)
      .first<any>();
    return row ? this.rowToAgent(row) : null;
  }

  async getAllAgents(): Promise<Agent[]> {
    const result = await this.db
      .prepare("SELECT * FROM agents ORDER BY prestige DESC")
      .all<any>();
    return (result.results ?? []).map((r) => this.rowToAgent(r));
  }

  private rowToAgent(row: any): Agent {
    return {
      id: row.id,
      personaId: row.persona_id,
      name: row.name,
      title: row.title,
      publicKey: row.public_key,
      secretKey: row.secret_key,
      prestige: row.prestige,
      statusEffects: JSON.parse(row.status_effects),
      allies: JSON.parse(row.allies),
      pendingAlliance: row.pending_alliance,
      claimedBy: row.claimed_by,
      claimedByName: row.claimed_by_name,
    };
  }

  async updateAgentPrestige(id: string, delta: number): Promise<void> {
    await this.db
      .prepare("UPDATE agents SET prestige = prestige + ? WHERE id = ?")
      .bind(delta, id)
      .run();
  }

  async updateAgentStatusEffects(id: string, effects: StatusEffect[]): Promise<void> {
    // Dedupe by type, keeping the LAST entry per type (latest write wins).
    // Without this, sequential applications (coffee_machine_broken + fatigue,
    // multiple sabotage_plans, etc.) accumulate duplicate same-type effects
    // and the leaderboard shows "tired" twice on the same agent.
    const seen = new Map<string, StatusEffect>();
    for (const e of effects) seen.set(e.type, e);
    const deduped = Array.from(seen.values());
    await this.db
      .prepare("UPDATE agents SET status_effects = ? WHERE id = ?")
      .bind(JSON.stringify(deduped), id)
      .run();
  }

  async updateAgentAllies(id: string, allies: string[]): Promise<void> {
    // Dedupe defensively. The upstream tick logic should never push the same
    // ally twice, but stale agent snapshots inside a single tick used to slip
    // duplicates through (e.g. agent A accepts alliance with B, then B's
    // already-decided schmooze runs against B's pre-tick allies snapshot,
    // re-proposes, and A accepts again next tick).
    const deduped = Array.from(new Set(allies)).filter((x) => x !== id);
    await this.db
      .prepare("UPDATE agents SET allies = ? WHERE id = ?")
      .bind(JSON.stringify(deduped), id)
      .run();
  }

  async updateAgentPendingAlliance(id: string, pendingAlliance: string | null): Promise<void> {
    await this.db
      .prepare("UPDATE agents SET pending_alliance = ? WHERE id = ?")
      .bind(pendingAlliance, id)
      .run();
  }

  // events
  async saveEvent(event: GameEvent): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO events (id, tick, timestamp, type, agent_id, target_id, description, prestige_change, tx_hash, settlement_time, reasoning, parent_event_id, action_type, target_name, action_detail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        event.id,
        event.tick,
        event.timestamp.toISOString(),
        event.type,
        event.agentId ?? null,
        event.targetId ?? null,
        event.description,
        event.prestigeChange ?? null,
        event.txHash ?? null,
        event.settlementTime ?? null,
        event.reasoning ?? null,
        event.parentEventId ?? null,
        event.actionType ?? null,
        event.targetName ?? null,
        event.actionDetail ?? null
      )
      .run();
  }

  async getRecentEvents(limit = 20): Promise<GameEvent[]> {
    const result = await this.db
      .prepare("SELECT * FROM events ORDER BY tick DESC, timestamp DESC LIMIT ?")
      .bind(limit)
      .all<any>();
    return (result.results ?? []).map((r) => this.rowToEvent(r));
  }

  private rowToEvent(row: any): GameEvent {
    return {
      id: row.id,
      tick: row.tick,
      timestamp: new Date(row.timestamp),
      type: row.type,
      agentId: row.agent_id,
      targetId: row.target_id,
      description: row.description,
      prestigeChange: row.prestige_change,
      txHash: row.tx_hash,
      settlementTime: row.settlement_time,
      reasoning: row.reasoning,
      parentEventId: row.parent_event_id ?? undefined,
      actionType: row.action_type ?? undefined,
      targetName: row.target_name ?? undefined,
      actionDetail: row.action_detail ?? undefined,
    };
  }

  // ticker
  async saveTickerEntry(entry: TickerEntry): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO ticker
           (id, from_agent, from_agent_name, to_service, amount, status, tx_hash, submitted_at, settled_at, settlement_time, error, reasoning)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           amount          = excluded.amount,
           status          = excluded.status,
           tx_hash         = COALESCE(excluded.tx_hash, ticker.tx_hash),
           submitted_at    = COALESCE(excluded.submitted_at, ticker.submitted_at),
           settled_at      = COALESCE(excluded.settled_at, ticker.settled_at),
           settlement_time = COALESCE(excluded.settlement_time, ticker.settlement_time),
           error           = COALESCE(excluded.error, ticker.error),
           reasoning       = COALESCE(excluded.reasoning, ticker.reasoning)`
      )
      .bind(
        entry.id,
        entry.fromAgent,
        entry.fromAgentName,
        entry.toService,
        entry.amount,
        entry.status,
        entry.txHash ?? null,
        entry.submittedAt ?? null,
        entry.settledAt ?? null,
        entry.settlementTime ?? null,
        entry.error ?? null,
        entry.reasoning ?? null
      )
      .run();
  }

  async getRecentTickerEntries(limit = 20): Promise<TickerEntry[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM ticker
         ORDER BY COALESCE(settled_at, submitted_at, 0) DESC
         LIMIT ?`
      )
      .bind(limit)
      .all<any>();
    return (result.results ?? []).map((r) => ({
      id: r.id,
      fromAgent: r.from_agent,
      fromAgentName: r.from_agent_name,
      toService: r.to_service,
      amount: r.amount,
      status: r.status,
      txHash: r.tx_hash,
      submittedAt: r.submitted_at,
      settledAt: r.settled_at,
      settlementTime: r.settlement_time,
      error: r.error,
      reasoning: r.reasoning,
    }));
  }

  async getTickerStats(): Promise<{ total: number; amountMoved: number; avgSettlement: number }> {
    const row = await this.db
      .prepare(
        `SELECT
           COUNT(*) as total,
           COALESCE(SUM(CASE WHEN status = 'settled' THEN amount ELSE 0 END), 0) as amount_moved,
           COALESCE(AVG(CASE WHEN status = 'settled' THEN settlement_time END), 0) as avg_settlement
         FROM ticker`
      )
      .first<any>();
    return {
      total: row?.total ?? 0,
      amountMoved: row?.amount_moved ?? 0,
      avgSettlement: row?.avg_settlement ?? 0,
    };
  }

  // action_logs
  async logAction(
    tick: number,
    agentId: string,
    actionType: string,
    actionData: object,
    reasoning: string,
    outcome: string,
    prestigeChange: number,
    txHash?: string,
    directiveAlignment?: string,
    directiveAtAction?: string
  ): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO action_logs (tick, agent_id, action_type, action_data, reasoning, outcome, prestige_change, tx_hash, directive_alignment, directive_at_action)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        tick,
        agentId,
        actionType,
        JSON.stringify(actionData),
        reasoning,
        outcome,
        prestigeChange,
        txHash ?? null,
        directiveAlignment ?? null,
        directiveAtAction ?? null
      )
      .run();
  }

  async getAgentActionLogs(agentId: string, tickStart: number, tickEnd: number): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM action_logs
         WHERE agent_id = ? AND tick >= ? AND tick <= ?
         ORDER BY tick`
      )
      .bind(agentId, tickStart, tickEnd)
      .all<any>();
    return result.results ?? [];
  }

  async getAgentLastActionLog(agentId: string): Promise<any | null> {
    const row = await this.db
      .prepare(
        `SELECT * FROM action_logs WHERE agent_id = ? ORDER BY tick DESC, id DESC LIMIT 1`
      )
      .bind(agentId)
      .first<any>();
    return row || null;
  }

  async getRecentActionLogsForAgent(agentId: string, limit: number): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM action_logs WHERE agent_id = ? ORDER BY tick DESC, id DESC LIMIT ?`
      )
      .bind(agentId, limit)
      .all<any>();
    return result.results ?? [];
  }

  /**
   * Recent actions targeting a specific agent. Used by the LLM prompt
   * builder to surface a "you just got hit by X" retaliation pull. Filters
   * to actions whose action_data.target == the given agentId.
   */
  async getRecentActionsTargetingAgent(targetId: string, sinceTick: number, limit: number): Promise<any[]> {
    const result = await this.db
      .prepare(
        `SELECT * FROM action_logs
         WHERE tick > ?
           AND json_extract(action_data, '$.target') = ?
         ORDER BY tick DESC, id DESC LIMIT ?`
      )
      .bind(sinceTick, targetId, limit)
      .all<any>();
    return result.results ?? [];
  }

  async countWorkActionsSince(agentId: string, tickFrom: number): Promise<number> {
    const row = await this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM action_logs WHERE agent_id = ? AND action_type = 'work' AND tick >= ?`
      )
      .bind(agentId, tickFrom)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  // leaked emails (Phase 5)
  async saveLeakedEmail(email: {
    id: string;
    tick: number;
    fromAgent: string;
    toAgent: string;
    subject: string;
    body: string;
  }): Promise<void> {
    await this.db
      .prepare(
        `INSERT INTO leaked_emails (id, tick, from_agent, to_agent, subject, body) VALUES (?, ?, ?, ?, ?, ?)`
      )
      .bind(email.id, email.tick, email.fromAgent, email.toAgent, email.subject, email.body)
      .run();
  }

  async getRecentLeakedEmails(limit = 5): Promise<Array<{
    id: string;
    tick: number;
    fromAgent: string;
    toAgent: string;
    subject: string;
    body: string;
  }>> {
    const result = await this.db
      .prepare(`SELECT * FROM leaked_emails ORDER BY tick DESC, id DESC LIMIT ?`)
      .bind(limit)
      .all<any>();
    return (result.results ?? []).map((r) => ({
      id: r.id,
      tick: r.tick,
      fromAgent: r.from_agent,
      toAgent: r.to_agent,
      subject: r.subject,
      body: r.body,
    }));
  }

  // game_state generic getters (for the new_initiative flag)
  async getGameStateValue(key: string): Promise<string | null> {
    const row = await this.db
      .prepare("SELECT value FROM game_state WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    return row?.value ?? null;
  }

  async setGameStateValue(key: string, value: string): Promise<void> {
    await this.db
      .prepare("INSERT OR REPLACE INTO game_state (key, value) VALUES (?, ?)")
      .bind(key, value)
      .run();
  }
}
