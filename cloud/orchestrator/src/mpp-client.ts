// MPP client for the orchestrator DO. Same logic as src/lib/mpp-client.ts on
// the laptop side, but the in-process event emitter is replaced with a
// caller-supplied onTickerUpdate callback so the DO controls fan-out.

import { Mppx, stellar } from "@stellar/mpp/charge/client";
import { Receipt } from "mppx";
import { Keypair } from "@stellar/stellar-sdk";
import type { TickerEntry } from "./types.js";

export type TickerCallback = (entry: TickerEntry) => void;

interface PaymentContext {
  entryId: string;
  agentId: string;
  agentName: string;
  serviceName: string;
  amount: number;
  submittedAt?: number;
  reasoning?: string;
}

export interface PaymentResult {
  success: boolean;
  data?: any;
  txHash?: string;
  settlementTime?: number;
  error?: string;
}

export class MppClient {
  constructor(private readonly onTickerUpdate: TickerCallback) {}

  private createAgentClient(
    agentId: string,
    agentName: string,
    keypair: Keypair,
    serviceName: string,
    priceDlbr: number,
    reasoning?: string
  ): { mppx: { fetch: typeof fetch }; entryId: string; ctx: PaymentContext } {
    const entryId = `${agentId}-${Date.now()}`;
    const ctx: PaymentContext = {
      entryId,
      agentId,
      agentName,
      serviceName,
      amount: priceDlbr,
      reasoning,
    };

    const emit = (entry: TickerEntry) => this.onTickerUpdate(entry);

    const mppx = Mppx.create({
      // workerd disallows reassignment of globalThis.fetch — Mppx.create's
      // default polyfill behavior throws. We use the returned mppx.fetch
      // explicitly anyway, so polyfill is unnecessary.
      polyfill: false,
      methods: [
        stellar.charge({
          keypair,
          mode: "pull",
          onProgress: (event) => {
            if (event.type === "challenge") {
              const challengeAmount = parseFloat(event.amount);
              emit({
                id: entryId,
                fromAgent: ctx.agentId,
                fromAgentName: ctx.agentName,
                toService: ctx.serviceName,
                amount: Number.isFinite(challengeAmount) ? challengeAmount : ctx.amount,
                status: "pending",
                reasoning: ctx.reasoning,
              });
            }

            if (event.type === "signed") {
              ctx.submittedAt = Date.now();
              emit({
                id: entryId,
                fromAgent: ctx.agentId,
                fromAgentName: ctx.agentName,
                toService: ctx.serviceName,
                amount: ctx.amount,
                status: "submitted",
                submittedAt: ctx.submittedAt,
                reasoning: ctx.reasoning,
              });
            }

            if (event.type === "paid") {
              const settledAt = Date.now();
              emit({
                id: entryId,
                fromAgent: ctx.agentId,
                fromAgentName: ctx.agentName,
                toService: ctx.serviceName,
                amount: ctx.amount,
                status: "settled",
                txHash: event.hash,
                submittedAt: ctx.submittedAt,
                settledAt,
                settlementTime: ctx.submittedAt
                  ? (settledAt - ctx.submittedAt) / 1000
                  : undefined,
                reasoning: ctx.reasoning,
              });
            }
          },
        }),
      ],
    });

    return { mppx, entryId, ctx };
  }

  async callPaidService(
    agentId: string,
    agentName: string,
    keypair: Keypair,
    serviceUrl: string,
    serviceName: string,
    priceDlbr: number,
    body?: object,
    reasoning?: string
  ): Promise<PaymentResult> {
    const { mppx: client, entryId } = this.createAgentClient(
      agentId,
      agentName,
      keypair,
      serviceName,
      priceDlbr,
      reasoning
    );
    const submittedAt = Date.now();

    try {
      const response = await client.fetch(serviceUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[mpp] ${agentName} → ${serviceName} HTTP ${response.status}\n  body: ${errorText.slice(0, 500)}`);

        if (errorText.includes("insufficient") || errorText.includes("underfunded")) {
          this.onTickerUpdate({
            id: entryId,
            fromAgent: agentId,
            fromAgentName: agentName,
            toService: serviceName,
            amount: priceDlbr,
            status: "failed",
            submittedAt,
            error: "insufficient funds",
            reasoning,
          });
          return { success: false, error: "Insufficient funds - payment rejected by network" };
        }

        return {
          success: false,
          error: `Service error: ${response.status} ${errorText.slice(0, 200)}`,
        };
      }

      const data = await response.json();

      let txHash: string | undefined;
      const receiptHeader = response.headers.get("Payment-Receipt");
      if (receiptHeader) {
        try {
          const receipt = Receipt.deserialize(receiptHeader);
          txHash = receipt.reference;
        } catch (err) {
          console.error(`[mpp] failed to parse Payment-Receipt for ${agentName}:`, err);
        }
      }

      const settledAt = Date.now();
      const settlementTime = (settledAt - submittedAt) / 1000;

      this.onTickerUpdate({
        id: entryId,
        fromAgent: agentId,
        fromAgentName: agentName,
        toService: serviceName,
        amount: priceDlbr,
        status: "settled",
        txHash,
        submittedAt,
        settledAt,
        settlementTime,
        reasoning,
      });

      return { success: true, data, txHash, settlementTime };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";

      if (errorMessage.includes("op_underfunded") || errorMessage.includes("insufficient")) {
        this.onTickerUpdate({
          id: entryId,
          fromAgent: agentId,
          fromAgentName: agentName,
          toService: serviceName,
          amount: 0,
          status: "failed",
          submittedAt,
          error: "op_underfunded",
          reasoning,
        });
      }

      return { success: false, error: errorMessage };
    }
  }
}

/**
 * Service URLs by action type. NPC base is read from env at construction time
 * so tests / wrangler dev can point at a local Worker if needed.
 */
export function buildServiceUrls(npcBase: string): Record<string, { url: string; name: string; price: number }> {
  const npc = (name: string, path: string) => npcBase.replace("__npc__", name) + path;
  return {
    buy_coffee:           { url: npc("coffee-cart",          "/buy"),                  name: "Coffee Cart",          price: 5 },
    buy_fancy_coffee:     { url: npc("coffee-cart",          "/buy-fancy"),            name: "Coffee Cart",          price: 10 },
    file_complaint:       { url: npc("hr-dept",              "/file-complaint"),       name: "HR Department",        price: 22 },
    sensitivity_training: { url: npc("hr-dept",              "/sensitivity-training"), name: "HR Department",        price: 30 },
    check_hr_status:      { url: npc("hr-dept",              "/check-status"),         name: "HR Department",        price: 5 },
    strategy_report:      { url: npc("consultant",           "/strategy-report"),      name: "The Consultant",       price: 25 },
    competitive_intel:    { url: npc("consultant",           "/competitive-intel"),    name: "The Consultant",       price: 25 },
    sabotage_plan:        { url: npc("consultant",           "/sabotage-plan"),        name: "The Consultant",       price: 40 },
    fix_laptop:           { url: npc("it-guy",               "/fix-laptop"),           name: "IT Guy",               price: 12 },
    recover_emails:       { url: npc("it-guy",               "/recover-emails"),       name: "IT Guy",               price: 20 },
    calendar_conflict:    { url: npc("it-guy",               "/calendar-conflict"),    name: "IT Guy",               price: 15 },
    book_ceo_time:        { url: npc("exec-assistant",       "/book-ceo-time"),        name: "Executive Assistant",  price: 50 },
    leak_org_chart:       { url: npc("exec-assistant",       "/leak-org-chart"),       name: "Executive Assistant",  price: 25 },
    schedule_conflict:    { url: npc("exec-assistant",       "/schedule-conflict"),    name: "Executive Assistant",  price: 30 },
    team_lunch:           { url: npc("caterer",              "/team-lunch"),           name: "The Caterer",          price: 25 },
    poison_meeting:       { url: npc("caterer",              "/poison-meeting"),       name: "The Caterer",          price: 35 },
    birthday_cake:        { url: npc("caterer",              "/birthday-cake"),        name: "The Caterer",          price: 12 },
    book_motivation:      { url: npc("motivational-speaker", "/book-session"),         name: "Motivational Speaker", price: 30 },
    send_motivation:      { url: npc("motivational-speaker", "/send-to-rival"),        name: "Motivational Speaker", price: 25 },

    // Phase 5 — earning paths.
    whistleblower_bounty: { url: npc("hr-dept",              "/whistleblower"),        name: "HR Department",        price: 10 },
    mentorship:           { url: npc("motivational-speaker", "/mentorship"),           name: "Motivational Speaker", price: 15 },
    coffee_chat:          { url: npc("coffee-cart",          "/coffee-chat"),          name: "Coffee Cart",          price: 5 },
  };
}

export function isPaidAction(actionType: string, urls: ReturnType<typeof buildServiceUrls>): boolean {
  return actionType in urls;
}
