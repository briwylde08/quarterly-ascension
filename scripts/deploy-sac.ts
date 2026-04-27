import "dotenv/config";
import { execSync } from "child_process";

const ASSET_CODE = process.env.ASSET_CODE;
const ASSET_ISSUER = process.env.ASSET_ISSUER;
const FUNDING_ACCOUNT_SECRET = process.env.FUNDING_ACCOUNT_SECRET;

function check(name: string, value: string | undefined): asserts value is string {
  if (!value) {
    console.error(`ERROR: ${name} is not set in .env`);
    console.error("Run scripts/create-issuer.ts first and add the printed lines to .env.");
    process.exit(1);
  }
}

async function main() {
  check("ASSET_CODE", ASSET_CODE);
  check("ASSET_ISSUER", ASSET_ISSUER);
  check("FUNDING_ACCOUNT_SECRET", FUNDING_ACCOUNT_SECRET);

  const asset = `${ASSET_CODE}:${ASSET_ISSUER}`;
  console.log(`Deploying Soroban Asset Contract for ${asset}...\n`);

  // Stellar CLI: deploy the SAC for a classic asset
  // --source-account accepts a secret key directly (starts with S)
  // The CLI picks up STELLAR_RPC_URL from env when --network is testnet, but
  // demands an explicit --network-passphrase alongside it. Pass both.
  const cmd = [
    "stellar contract asset deploy",
    `--asset ${asset}`,
    "--rpc-url https://soroban-testnet.stellar.org",
    `--network-passphrase 'Test SDF Network ; September 2015'`,
    `--source-account ${FUNDING_ACCOUNT_SECRET}`,
  ].join(" ");

  let output: string;
  try {
    output = execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (err: any) {
    const stderr = err.stderr?.toString() || "";
    const stdout = err.stdout?.toString() || "";

    // If the SAC already exists for this asset, the CLI will say so and we
    // can still extract the contract ID — we don't need a fresh deploy.
    const existing = stderr + stdout;
    const alreadyMatch = existing.match(/already.*?(C[A-Z0-9]{55})/);
    if (alreadyMatch) {
      console.log(`SAC already exists for ${asset}.`);
      output = alreadyMatch[1];
    } else {
      console.error("ERROR: stellar CLI failed.");
      console.error(stderr || stdout || err.message);
      process.exit(1);
    }
  }

  // Stellar CLI prints the contract ID on its own line. It starts with "C" and
  // is 56 characters of base32-ish caps. Grab the first match.
  const contractId = (output.match(/C[A-Z0-9]{55}/) || [])[0];
  if (!contractId) {
    console.error("ERROR: could not parse contract ID from CLI output:");
    console.error(output);
    process.exit(1);
  }

  console.log();
  console.log("=".repeat(60));
  console.log("SAC DEPLOYED");
  console.log("=".repeat(60));
  console.log();
  console.log(`Contract ID: ${contractId}`);
  console.log();
  console.log("Add this line to your .env file:");
  console.log();
  console.log(`   ASSET_SAC=${contractId}`);
  console.log();
  console.log("Next:");
  console.log("   npx tsx scripts/migrate-trustlines.ts");
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
