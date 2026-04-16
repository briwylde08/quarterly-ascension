import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "Coffee Cart",
  port: 3010,
  recipientAddress: process.env.COFFEE_CART_ADDRESS || "",
};

const service = createNpcService(config, [
  {
    path: "/buy",
    price: 8,
    handler: (req: Request, res: Response) => {
      res.json({
        item: "coffee",
        effect: "productivity_boost",
        description: "A mediocre cup of corporate coffee",
        flavor: "Hints of burnt beans and existential dread",
        statusEffect: {
          type: "removes_tired",
          duration: null,
        },
      });
    },
  },
  {
    path: "/buy-fancy",
    price: 15,
    handler: (req: Request, res: Response) => {
      res.json({
        item: "fancy_coffee",
        effect: "caffeinated",
        description: "An artisanal pour-over that costs more than your hourly wage",
        flavor: "Notes of superiority and oat milk",
        statusEffect: {
          type: "caffeinated",
          duration: 2,  // ticks
        },
      });
    },
  },
]);

// Export for programmatic use
export { service, config };

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
