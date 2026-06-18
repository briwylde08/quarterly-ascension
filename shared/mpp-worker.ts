import { Mppx, stellar, Store } from "@stellar/mpp/charge/server";

/**
 * MPP middleware factory for Cloudflare Workers.
 *
 * Workers receive a native Web Request — no Express-or-Node adapter needed.
 * This is the cloud-native version of src/services/base.ts.
 *
 * Usage from an NPC Worker's fetch handler:
 *
 *     const charge = createCharge(env);
 *     const { result, challengeOrPayload } = await charge(request, price);
 *     if (challengeOrPayload) return challengeOrPayload;
 *     // payment cleared — produce the success response with receipt header
 *     return result.withReceipt(Response.json(payload));
 */

export interface WorkerEnv {
  ASSET_SAC: string;
  MPP_SECRET: string;
  // Each NPC's wrangler.jsonc adds its own RECIPIENT_ADDRESS binding.
  RECIPIENT_ADDRESS: string;
}

type Charge = (request: Request, priceDlbr: number) => Promise<
  | { settled: true; result: { withReceipt(response: Response): Response } }
  | { settled: false; response: Response }
>;

export function createCharge(env: WorkerEnv): Charge {
  if (!env.ASSET_SAC) throw new Error("ASSET_SAC binding missing");
  if (!env.MPP_SECRET) throw new Error("MPP_SECRET binding missing");
  if (!env.RECIPIENT_ADDRESS) throw new Error("RECIPIENT_ADDRESS binding missing");

  const mppx = Mppx.create({
    secretKey: env.MPP_SECRET,
    methods: [
      stellar.charge({
        recipient: env.RECIPIENT_ADDRESS,
        currency: env.ASSET_SAC,
        network: "stellar:testnet",
        store: Store.memory(),
      }),
    ],
  });

  return async (request, priceDlbr) => {
    const result = await mppx.stellar.charge({
      amount: priceDlbr.toString(),
    })(request);

    if (result.status === 402) {
      return { settled: false, response: result.challenge as unknown as Response };
    }

    return { settled: true, result: result as { withReceipt(response: Response): Response } };
  };
}
