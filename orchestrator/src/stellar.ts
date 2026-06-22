// Stellar helpers needed at orchestrator runtime — balance lookup, asset
// transfers (for Phase 5 reward payouts and on-chain budget burns), and
// explorer URL formatting.

import { Asset, Horizon, Keypair, Networks, Operation, TransactionBuilder } from "@stellar/stellar-sdk";

export interface StellarConfig {
  network: string;          // "testnet" or "public"
  horizonUrl: string;
  assetCode: string;
  assetIssuer: string;
}

export class Stellar {
  private horizon: Horizon.Server;
  private asset: Asset | null;
  private networkPassphrase: string;

  constructor(private cfg: StellarConfig) {
    this.horizon = new Horizon.Server(cfg.horizonUrl);
    this.asset = cfg.assetIssuer ? new Asset(cfg.assetCode, cfg.assetIssuer) : null;
    this.networkPassphrase = cfg.network === "testnet" ? Networks.TESTNET : Networks.PUBLIC;
  }

  async getAssetBalance(publicKey: string): Promise<number> {
    if (!this.cfg.assetIssuer) return 0;
    // ROOT-CAUSE FIX (retreat post-mortem): we used to call
    // `this.horizon.loadAccount(publicKey)`, which goes through stellar-sdk's
    // internal fetch. Under Cloudflare Workers, that fetch can be served
    // from the edge cache, returning a stale snapshot. Once a stale $0 read
    // got cached during the reset's burn/mint window, every subsequent tick
    // saw $0, the LLM's available-actions filter dropped every paid action,
    // and 41 of 60 ticks went silent on-chain.
    //
    // The fix: direct fetch with `cache: 'no-store'` so each balance read
    // hits Horizon live. Structured logs on the catch path so future
    // failures are forensically visible instead of silently falling to 0.
    const url = `${this.cfg.horizonUrl}/accounts/${publicKey}`;
    try {
      // Cloudflare Workers don't honor the standard `cache: 'no-store'`
      // RequestInit — they expose cache control via the `cf` property and
      // standard HTTP Cache-Control headers. Belt-and-suspenders: both.
      const r = await fetch(url, {
        cf: { cacheTtl: 0, cacheEverything: false },
        headers: { "Cache-Control": "no-cache, no-store" },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) {
        console.error(`[stellar] balance read non-OK for ${publicKey.slice(0, 8)}…: HTTP ${r.status}`);
        return 0;
      }
      const account = await r.json() as {
        balances: Array<{
          asset_type: string;
          asset_code?: string;
          asset_issuer?: string;
          balance: string;
        }>;
      };
      const balance = account.balances.find(
        (b) =>
          (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
          b.asset_code === this.cfg.assetCode &&
          b.asset_issuer === this.cfg.assetIssuer
      );
      return balance ? parseFloat(balance.balance) : 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      console.error(`[stellar] balance read threw for ${publicKey.slice(0, 8)}…: ${msg}`);
      return 0;
    }
  }

  /**
   * Classify a Stellar SDK error as transient (worth retrying) vs terminal.
   * Transient cases — testnet RPC desync, network blips, brief 5xx:
   *   - "Account not found" / 404 from loadAccount when the routed Horizon
   *     node is a few ledgers behind canonical
   *   - op_no_destination, same root cause but at submission time
   *   - tx_bad_seq, which self-resolves on the retry because we rebuild
   *     the tx with a fresh loadAccount
   *   - Network errors (timeout, ECONNRESET, fetch failed)
   *   - Gateway 5xx
   * Terminal cases that should bubble immediately (no retry):
   *   - op_underfunded, tx_failed for permanent reasons, bad signatures,
   *     tx_too_late (the 30s tx_validity window expired)
   */
  private isTransientStellarError(err: unknown): boolean {
    if (!(err instanceof Error)) return false;
    const msg = err.message.toLowerCase();
    if (msg.includes("not found")) return true;
    if (msg.includes("op_no_destination")) return true;
    if (msg.includes("tx_bad_seq")) return true;
    if (msg.includes("timeout") || msg.includes("etimedout")) return true;
    if (msg.includes("econnreset") || msg.includes("econnrefused")) return true;
    if (msg.includes("fetch failed") || msg.includes("network error")) return true;
    if (/\b50[234]\b/.test(msg)) return true; // 502/503/504
    return false;
  }

  /**
   * Send the game asset from one account to another. Used by Phase 5 for:
   *   - Budget Cuts: each agent → asset issuer (effective burn)
   *   - Bounty payouts: HR / Motivational Speaker → agent
   *
   * Returns the tx hash on success. Wraps the whole submit cycle in a
   * retry-on-transient-error loop because Stellar Testnet's public Horizon
   * endpoints occasionally route requests to a lagging node, producing
   * spurious "Account not found" errors that resolve within 5-10 seconds
   * once the node ingests the latest ledger (or the LB rotates to a
   * healthy node). Game-3 saw 6 paid actions burn turns across a single
   * ~15-minute desync window.
   *
   * Each retry does a fresh loadAccount + rebuild, so tx_bad_seq self-
   * resolves and we don't replay a stale sequence number. Backoff is
   * 1.5s then 3s — comfortably inside an 8-minute tick budget.
   *
   * Throws on terminal errors so the caller can log and continue.
   */
  async sendAsset(fromSecret: string, toPublicKey: string, amount: number): Promise<string> {
    if (!this.asset) throw new Error("ASSET_ISSUER not configured");
    const maxAttempts = 3;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const fromKeypair = Keypair.fromSecret(fromSecret);
        const account = await this.horizon.loadAccount(fromKeypair.publicKey());
        const tx = new TransactionBuilder(account, {
          fee: "100",
          networkPassphrase: this.networkPassphrase,
        })
          .addOperation(
            Operation.payment({
              destination: toPublicKey,
              asset: this.asset,
              amount: amount.toFixed(7),
            })
          )
          .setTimeout(30)
          .build();
        tx.sign(fromKeypair);
        const result = await this.horizon.submitTransaction(tx);
        if (attempt > 1) {
          console.log(`[stellar] sendAsset recovered on attempt ${attempt}/${maxAttempts}`);
        }
        return result.hash;
      } catch (err) {
        lastErr = err;
        if (!this.isTransientStellarError(err) || attempt === maxAttempts) {
          throw err;
        }
        const delayMs = 1500 * Math.pow(2, attempt - 1); // 1500, 3000
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[stellar] sendAsset attempt ${attempt}/${maxAttempts} transient failure; retrying in ${delayMs}ms: ${msg.slice(0, 200)}`
        );
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
    throw lastErr;
  }

  /**
   * Burn the game asset by sending it back to the issuer. (On Stellar, sending
   * an asset to its issuer destroys supply.)
   */
  async burn(fromSecret: string, amount: number): Promise<string> {
    if (!this.cfg.assetIssuer) throw new Error("ASSET_ISSUER not configured");
    return this.sendAsset(fromSecret, this.cfg.assetIssuer, amount);
  }

  getExplorerTxUrl(txHash: string): string {
    const network = this.cfg.network === "testnet" ? "testnet" : "public";
    return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
  }

  getExplorerAccountUrl(publicKey: string): string {
    const network = this.cfg.network === "testnet" ? "testnet" : "public";
    return `https://stellar.expert/explorer/${network}/account/${publicKey}`;
  }
}
