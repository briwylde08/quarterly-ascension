import * as StellarSdk from "@stellar/stellar-sdk";
import { Keypair, Networks, Horizon, Asset, TransactionBuilder, Operation } from "@stellar/stellar-sdk";

// Network configuration
const NETWORK = process.env.STELLAR_NETWORK || "testnet";
const HORIZON_URL = process.env.STELLAR_HORIZON_URL || "https://horizon-testnet.stellar.org";
const NETWORK_PASSPHRASE = NETWORK === "testnet" ? Networks.TESTNET : Networks.PUBLIC;

// Asset configuration (game currency — defaults to Deliverabills / DLBR)
const ASSET_CODE = process.env.ASSET_CODE || "DLBR";
const ASSET_ISSUER = process.env.ASSET_ISSUER || "";
const ASSET = ASSET_ISSUER ? new Asset(ASSET_CODE, ASSET_ISSUER) : null;

// Horizon server
const horizon = new Horizon.Server(HORIZON_URL);

export interface AccountInfo {
  publicKey: string;
  secretKey: string;
  assetBalance: number;
  xlmBalance: number;
}

function requireAsset(): Asset {
  if (!ASSET) {
    throw new Error(
      "ASSET_ISSUER is not set in .env. Run scripts/create-issuer.ts to create the game asset issuer first."
    );
  }
  return ASSET;
}

/**
 * Generate a new random Stellar keypair
 */
export function generateKeypair(): { publicKey: string; secretKey: string } {
  const keypair = Keypair.random();
  return {
    publicKey: keypair.publicKey(),
    secretKey: keypair.secret(),
  };
}

/**
 * Fund an account on testnet using Friendbot
 */
export async function fundWithFriendbot(publicKey: string): Promise<void> {
  const response = await fetch(`https://friendbot.stellar.org?addr=${publicKey}`);
  if (!response.ok) {
    throw new Error(`Friendbot funding failed: ${response.statusText}`);
  }
  console.log(`Funded ${publicKey.slice(0, 8)}... with testnet XLM`);
}

/**
 * Add a trustline for the game asset to an account.
 */
export async function addAssetTrustline(secretKey: string): Promise<string> {
  const asset = requireAsset();
  const keypair = Keypair.fromSecret(secretKey);
  const account = await horizon.loadAccount(keypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.changeTrust({
        asset,
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(keypair);
  const result = await horizon.submitTransaction(tx);
  console.log(`Added ${ASSET_CODE} trustline for ${keypair.publicKey().slice(0, 8)}...`);
  return result.hash;
}

/**
 * Get balance of the game asset for an account.
 */
export async function getAssetBalance(publicKey: string): Promise<number> {
  if (!ASSET) return 0;
  try {
    const account = await horizon.loadAccount(publicKey);
    const balance = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLineAsset =>
        (b.asset_type === "credit_alphanum4" || b.asset_type === "credit_alphanum12") &&
        b.asset_code === ASSET_CODE &&
        b.asset_issuer === ASSET_ISSUER
    );
    return balance ? parseFloat(balance.balance) : 0;
  } catch (error) {
    console.error(`Failed to get balance for ${publicKey}:`, error);
    return 0;
  }
}

/**
 * Get XLM balance for an account
 */
export async function getXlmBalance(publicKey: string): Promise<number> {
  try {
    const account = await horizon.loadAccount(publicKey);
    const xlmBalance = account.balances.find(
      (b): b is Horizon.HorizonApi.BalanceLineNative => b.asset_type === "native"
    );
    return xlmBalance ? parseFloat(xlmBalance.balance) : 0;
  } catch (error) {
    console.error(`Failed to get XLM balance for ${publicKey}:`, error);
    return 0;
  }
}

/**
 * Get full account info
 */
export async function getAccountInfo(publicKey: string, secretKey: string): Promise<AccountInfo> {
  const [assetBalance, xlmBalance] = await Promise.all([
    getAssetBalance(publicKey),
    getXlmBalance(publicKey),
  ]);

  return {
    publicKey,
    secretKey,
    assetBalance,
    xlmBalance,
  };
}

/**
 * Send the game asset from one account to another (direct transfer, not MPP).
 * Used for initial funding of agent accounts.
 */
export async function sendAsset(
  fromSecret: string,
  toPublicKey: string,
  amount: number
): Promise<string> {
  const asset = requireAsset();
  const fromKeypair = Keypair.fromSecret(fromSecret);
  const account = await horizon.loadAccount(fromKeypair.publicKey());

  const tx = new TransactionBuilder(account, {
    fee: "100",
    networkPassphrase: NETWORK_PASSPHRASE,
  })
    .addOperation(
      Operation.payment({
        destination: toPublicKey,
        asset,
        amount: amount.toFixed(7),
      })
    )
    .setTimeout(30)
    .build();

  tx.sign(fromKeypair);
  const result = await horizon.submitTransaction(tx);
  console.log(`Sent ${amount} ${ASSET_CODE} to ${toPublicKey.slice(0, 8)}... (tx: ${result.hash.slice(0, 8)}...)`);
  return result.hash;
}

/**
 * Check if an account exists on the network
 */
export async function accountExists(publicKey: string): Promise<boolean> {
  try {
    await horizon.loadAccount(publicKey);
    return true;
  } catch (error) {
    return false;
  }
}

/**
 * Get a transaction URL on stellar.expert
 */
export function getExplorerTxUrl(txHash: string): string {
  const network = NETWORK === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${network}/tx/${txHash}`;
}

/**
 * Get an account URL on stellar.expert
 */
export function getExplorerAccountUrl(publicKey: string): string {
  const network = NETWORK === "testnet" ? "testnet" : "public";
  return `https://stellar.expert/explorer/${network}/account/${publicKey}`;
}

export {
  horizon,
  NETWORK,
  NETWORK_PASSPHRASE,
  ASSET,
  ASSET_CODE,
  ASSET_ISSUER,
  Keypair,
};
