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
    try {
      const account = await this.horizon.loadAccount(publicKey);
      const balance = account.balances.find(
        (b): b is Horizon.HorizonApi.BalanceLineAsset =>
          (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
          b.asset_code === this.cfg.assetCode &&
          b.asset_issuer === this.cfg.assetIssuer
      );
      return balance ? parseFloat(balance.balance) : 0;
    } catch (error) {
      console.error(`Failed to get balance for ${publicKey}:`, error);
      return 0;
    }
  }

  /**
   * Send the game asset from one account to another. Used by Phase 5 for:
   *   - Budget Cuts: each agent → asset issuer (effective burn)
   *   - Bounty payouts: HR / Motivational Speaker → agent
   *
   * Returns the tx hash on success. Throws on submission errors so the
   * caller can decide whether the failure is fatal or worth swallowing.
   */
  async sendAsset(fromSecret: string, toPublicKey: string, amount: number): Promise<string> {
    if (!this.asset) throw new Error("ASSET_ISSUER not configured");
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
    return result.hash;
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
