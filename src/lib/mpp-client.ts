import { Mppx, stellar } from "@stellar/mpp/charge/client";
import { Receipt } from "mppx";
import { Keypair } from "@stellar/stellar-sdk";
import { TickerEntry } from "./types.js";
import { saveTickerEntry } from "./db.js";
import { getExplorerTxUrl } from "./stellar.js";

// Event emitter for ticker updates
type TickerCallback = (entry: TickerEntry) => void;
const tickerCallbacks: TickerCallback[] = [];

export function onTickerUpdate(callback: TickerCallback): void {
  tickerCallbacks.push(callback);
}

function emitTickerUpdate(entry: TickerEntry): void {
  saveTickerEntry(entry);
  for (const callback of tickerCallbacks) {
    callback(entry);
  }
}

// Track in-flight payments for ticker correlation
interface PaymentContext {
  entryId: string;
  agentId: string;
  agentName: string;
  serviceName: string;
  amount: number;
  submittedAt?: number;
  reasoning?: string;  // In-character LLM reasoning, surfaced on every ticker emit
}

const paymentContexts = new Map<string, PaymentContext>();

/**
 * Create an MPP client for an agent with progress tracking
 * Returns the mppx client and entryId for tracking
 */
export function createAgentMppClient(
  agentId: string,
  agentName: string,
  keypair: Keypair,
  serviceName: string,
  priceUsdc: number,
  reasoning?: string
): { mppx: { fetch: typeof fetch }; entryId: string } {
  const entryId = `${agentId}-${Date.now()}`;

  // Store context for this payment
  paymentContexts.set(entryId, {
    entryId,
    agentId,
    agentName,
    serviceName,
    amount: priceUsdc,
    reasoning,
  });

  const mppx = Mppx.create({
    methods: [
      stellar.charge({
        keypair,
        mode: "pull", // Server assembles tx, agent just signs auth entries
        onProgress(event) {
          const ctx = paymentContexts.get(entryId);
          if (!ctx) return;

          if (event.type === "challenge") {
            // Received 402, about to sign. The server now sends the human
            // amount (post 79cdc73), so use it directly — don't divide by
            // 10^7. Fall back to ctx.amount if the event field is missing.
            const challengeAmount = parseFloat(event.amount);
            emitTickerUpdate({
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
            // Auth entries signed, submitting to network
            ctx.submittedAt = Date.now();
            emitTickerUpdate({
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
            // Transaction confirmed on chain
            const settledAt = Date.now();
            emitTickerUpdate({
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
            // Clean up context
            paymentContexts.delete(entryId);
          }
        },
      }),
    ],
  });

  return { mppx, entryId };
}

/**
 * Result of a paid service call
 */
export interface PaymentResult {
  success: boolean;
  data?: any;
  txHash?: string;
  settlementTime?: number;
  error?: string;
}

/**
 * Call a paid NPC service on behalf of an agent
 */
export async function callPaidService(
  agentId: string,
  agentName: string,
  keypair: Keypair,
  serviceUrl: string,
  serviceName: string,
  priceUsdc: number,
  body?: object,
  reasoning?: string
): Promise<PaymentResult> {
  const { mppx: client, entryId } = createAgentMppClient(
    agentId,
    agentName,
    keypair,
    serviceName,
    priceUsdc,
    reasoning
  );
  const submittedAt = Date.now();

  try {
    const response = await client.fetch(serviceUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[mpp] ${agentName} → ${serviceName} HTTP ${response.status}\n  body: ${errorText.slice(0, 500)}`);

      if (errorText.includes("insufficient") || errorText.includes("underfunded")) {
        emitTickerUpdate({
          id: entryId,
          fromAgent: agentId,
          fromAgentName: agentName,
          toService: serviceName,
          amount: priceUsdc,
          status: "failed",
          submittedAt,
          error: "insufficient funds",
          reasoning,
        });

        return {
          success: false,
          error: "Insufficient funds - payment rejected by network",
        };
      }

      return {
        success: false,
        error: `Service error: ${response.status} ${errorText.slice(0, 200)}`,
      };
    }

    const data = await response.json();

    // Pull the tx hash out of the MPP Payment-Receipt header (base64url JSON,
    // with `reference` holding the Stellar tx hash for the charge method).
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

    // Promote the ticker entry from "submitted" to "settled" with the hash
    // we just learned about.
    emitTickerUpdate({
      id: entryId,
      fromAgent: agentId,
      fromAgentName: agentName,
      toService: serviceName,
      amount: priceUsdc,
      status: "settled",
      txHash,
      submittedAt,
      settledAt,
      settlementTime,
      reasoning,
    });

    return {
      success: true,
      data,
      txHash,
      settlementTime,
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";

    // Check if it's a payment failure
    if (errorMessage.includes("op_underfunded") || errorMessage.includes("insufficient")) {
      emitTickerUpdate({
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

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Service URLs by action type.
 *
 * NPC services live on Cloudflare Workers as of Phase 1 of the migration.
 * Override the base via NPC_BASE_URL_OVERRIDE for local development against
 * `wrangler dev` instances; production points at the deployed *.workers.dev
 * subdomains.
 */
const NPC_BASE = process.env.NPC_BASE_URL_OVERRIDE || "https://__npc__.briana-761.workers.dev";
const npc = (name: string, path: string) => NPC_BASE.replace("__npc__", name) + path;

export const SERVICE_URLS: Record<string, { url: string; name: string; price: number }> = {
  buy_coffee:           { url: npc("coffee-cart",          "/buy"),                  name: "Coffee Cart",          price: 8 },
  buy_fancy_coffee:     { url: npc("coffee-cart",          "/buy-fancy"),            name: "Coffee Cart",          price: 15 },
  file_complaint:       { url: npc("hr-dept",              "/file-complaint"),       name: "HR Department",        price: 22 },
  sensitivity_training: { url: npc("hr-dept",              "/sensitivity-training"), name: "HR Department",        price: 30 },
  check_hr_status:      { url: npc("hr-dept",              "/check-status"),         name: "HR Department",        price: 5 },
  strategy_report:      { url: npc("consultant",           "/strategy-report"),      name: "The Consultant",       price: 35 },
  competitive_intel:    { url: npc("consultant",           "/competitive-intel"),    name: "The Consultant",       price: 25 },
  sabotage_plan:        { url: npc("consultant",           "/sabotage-plan"),        name: "The Consultant",       price: 40 },
  fix_laptop:           { url: npc("it-guy",               "/fix-laptop"),           name: "IT Guy",               price: 18 },
  recover_emails:       { url: npc("it-guy",               "/recover-emails"),       name: "IT Guy",               price: 20 },
  calendar_conflict:    { url: npc("it-guy",               "/calendar-conflict"),    name: "IT Guy",               price: 15 },
  book_ceo_time:        { url: npc("exec-assistant",       "/book-ceo-time"),        name: "Executive Assistant",  price: 50 },
  leak_org_chart:       { url: npc("exec-assistant",       "/leak-org-chart"),       name: "Executive Assistant",  price: 25 },
  schedule_conflict:    { url: npc("exec-assistant",       "/schedule-conflict"),    name: "Executive Assistant",  price: 30 },
  team_lunch:           { url: npc("caterer",              "/team-lunch"),           name: "The Caterer",          price: 25 },
  poison_meeting:       { url: npc("caterer",              "/poison-meeting"),       name: "The Caterer",          price: 35 },
  birthday_cake:        { url: npc("caterer",              "/birthday-cake"),        name: "The Caterer",          price: 12 },
  book_motivation:      { url: npc("motivational-speaker", "/book-session"),         name: "Motivational Speaker", price: 30 },
  send_motivation:      { url: npc("motivational-speaker", "/send-to-rival"),        name: "Motivational Speaker", price: 35 },
};

/**
 * Check if an action type requires payment
 */
export function isPaidAction(actionType: string): boolean {
  return actionType in SERVICE_URLS;
}

/**
 * Get the price of an action in DLBR
 */
export function getActionPrice(actionType: string): number {
  return SERVICE_URLS[actionType]?.price || 0;
}
