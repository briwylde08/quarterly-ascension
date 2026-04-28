import express from "express";
import type { Express, Request, Response, NextFunction } from "express";
import { Mppx, stellar, Store } from "@stellar/mpp/charge/server";
import { Request as MppRequest } from "mppx/server";

const ASSET_SAC = process.env.ASSET_SAC || process.env.USDC_SAC || "";
const MPP_SECRET = process.env.MPP_SECRET || "default-mpp-secret";

if (!ASSET_SAC) {
  throw new Error("ASSET_SAC is not set in .env. Run scripts/deploy-sac.ts to deploy the Soroban Asset Contract for the game asset.");
}

export interface ServiceConfig {
  name: string;
  port: number;
  recipientAddress: string;
}

export interface EndpointConfig {
  path: string;
  price: number;  // In the game asset (DLBR)
  handler: (req: Request, res: Response) => void | Promise<void>;
}

/**
 * Check if game is halted (services return 503)
 */
let gameHalted = false;

export function setGameHalted(halted: boolean): void {
  gameHalted = halted;
}

export function isGameHalted(): boolean {
  return gameHalted;
}

/**
 * Create an NPC service with MPP payment middleware
 */
export function createNpcService(config: ServiceConfig, endpoints: EndpointConfig[]): Express {
  const app = express();
  app.use(express.json());

  // Create MPP handler for this service
  const mppx = Mppx.create({
    secretKey: MPP_SECRET,
    methods: [
      stellar.charge({
        recipient: config.recipientAddress,
        currency: ASSET_SAC,
        network: "stellar:testnet",
        store: Store.memory(), // Use memory store for dev
      }),
    ],
  });

  // Game halt check middleware
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (gameHalted) {
      res.status(503).json({ error: "Game paused", service: config.name });
      return;
    }
    next();
  });

  // Health check (no payment required)
  app.get("/health", (req, res) => {
    res.json({ service: config.name, status: "ok", halted: gameHalted });
  });

  // Create MPP-protected endpoints
  for (const endpoint of endpoints) {
    app.post(endpoint.path, async (req: Request, res: Response) => {
      try {
        // mppx's HTTP transport reads from Web Request (.headers.get(...)).
        // Express gives us a Node IncomingMessage. Convert via mppx's adapter
        // before handing to the charge handler — otherwise the credential
        // header is invisible and the server returns "Malformed Credential".
        const webRequest = MppRequest.fromNodeListener(req, res);

        // The MPP server method calls toBaseUnits() internally — pass the
        // human-readable price as a string and let the lib do the scaling.
        const result = await mppx.stellar.charge({
          amount: endpoint.price.toString(),
        })(webRequest);

        if (result.status === 402) {
          // Return the 402 challenge response
          const challengeResponse = result.challenge as globalThis.Response;
          res.status(402);
          for (const [key, value] of challengeResponse.headers.entries()) {
            res.setHeader(key, value);
          }
          res.send(await challengeResponse.text());
          return;
        }

        // Payment verified - execute the handler
        // Set the receipt header
        result.withReceipt(new Response()).headers.forEach((value, key) => {
          res.setHeader(key, value);
        });

        await endpoint.handler(req, res);
      } catch (error) {
        console.error(`Error in ${config.name}${endpoint.path}:`, error);
        res.status(500).json({ error: "Internal service error" });
      }
    });
  }

  return app;
}

/**
 * Start an NPC service
 */
export function startService(app: Express, config: ServiceConfig): void {
  app.listen(config.port, () => {
    console.log(`${config.name} running on :${config.port}`);
  });
}
