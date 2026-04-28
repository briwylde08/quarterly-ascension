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
  priceUsdc: number
): { mppx: { fetch: typeof fetch }; entryId: string } {
  const entryId = `${agentId}-${Date.now()}`;

  // Store context for this payment
  paymentContexts.set(entryId, {
    entryId,
    agentId,
    agentName,
    serviceName,
    amount: priceUsdc,
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
            // Received 402, about to sign
            emitTickerUpdate({
              id: entryId,
              fromAgent: ctx.agentId,
              fromAgentName: ctx.agentName,
              toService: ctx.serviceName,
              amount: parseFloat(event.amount) / 10_000_000,
              status: "pending",
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
  body?: object
): Promise<PaymentResult> {
  const { mppx: client, entryId } = createAgentMppClient(
    agentId,
    agentName,
    keypair,
    serviceName,
    priceUsdc
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
      });
    }

    return {
      success: false,
      error: errorMessage,
    };
  }
}

/**
 * Service URLs by action type
 */
export const SERVICE_URLS: Record<string, { url: string; name: string; price: number }> = {
  buy_coffee: { url: "http://localhost:3010/buy", name: "Coffee Cart", price: 8 },
  buy_fancy_coffee: { url: "http://localhost:3010/buy-fancy", name: "Coffee Cart", price: 15 },
  file_complaint: { url: "http://localhost:3011/file-complaint", name: "HR Department", price: 22 },
  sensitivity_training: { url: "http://localhost:3011/sensitivity-training", name: "HR Department", price: 30 },
  check_hr_status: { url: "http://localhost:3011/check-status", name: "HR Department", price: 5 },
  strategy_report: { url: "http://localhost:3012/strategy-report", name: "The Consultant", price: 35 },
  competitive_intel: { url: "http://localhost:3012/competitive-intel", name: "The Consultant", price: 25 },
  sabotage_plan: { url: "http://localhost:3012/sabotage-plan", name: "The Consultant", price: 40 },
  fix_laptop: { url: "http://localhost:3013/fix-laptop", name: "IT Guy", price: 18 },
  recover_emails: { url: "http://localhost:3013/recover-emails", name: "IT Guy", price: 20 },
  calendar_conflict: { url: "http://localhost:3013/calendar-conflict", name: "IT Guy", price: 15 },
  book_ceo_time: { url: "http://localhost:3014/book-ceo-time", name: "Executive Assistant", price: 50 },
  leak_org_chart: { url: "http://localhost:3014/leak-org-chart", name: "Executive Assistant", price: 25 },
  schedule_conflict: { url: "http://localhost:3014/schedule-conflict", name: "Executive Assistant", price: 30 },
  team_lunch: { url: "http://localhost:3015/team-lunch", name: "The Caterer", price: 25 },
  poison_meeting: { url: "http://localhost:3015/poison-meeting", name: "The Caterer", price: 35 },
  birthday_cake: { url: "http://localhost:3015/birthday-cake", name: "The Caterer", price: 12 },
  book_motivation: { url: "http://localhost:3016/book-session", name: "Motivational Speaker", price: 30 },
  send_motivation: { url: "http://localhost:3016/send-to-rival", name: "Motivational Speaker", price: 35 },
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
