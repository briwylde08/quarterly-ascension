import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "The Caterer",
  port: 3015,
  recipientAddress: process.env.CATERER_ADDRESS || "",
};

const lunchMenus = [
  "Artisanal sandwich platter with quinoa salad",
  "Build-your-own taco bar (vegetarian options available)",
  "Mediterranean mezze spread",
  "Sushi and poke bowls",
  "Classic deli spread with three types of coleslaw",
];

const cakeMessages = [
  "Happy Birthday! (Even though it's not your birthday)",
  "Congratulations on your continued employment!",
  "Thanks for being a team player!",
  "Here's to another fiscal quarter!",
];

const poisonSymptoms = [
  "mild food poisoning",
  "suspicious stomach issues",
  "an unfortunate allergic reaction",
  "concerns about the mayonnaise",
];

function randomItem<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const service = createNpcService(config, [
  {
    path: "/team-lunch",
    price: 25,
    handler: (req: Request, res: Response) => {
      const menu = randomItem(lunchMenus);
      res.json({
        action: "team_lunch_hosted",
        effect: "prestige_boost",
        description: "Hosted a team lunch - everyone appreciates free food",
        menu,
        attendeeCount: Math.floor(Math.random() * 8) + 5,
        catererNote: "Nothing brings people together like carbs",
        prestigeChange: 15,
        // Chance to form alliance with random attendee
        allianceChance: 0.3,
      });
    },
  },
  {
    path: "/poison-meeting",
    price: 35,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      const symptom = randomItem(poisonSymptoms);
      res.json({
        action: "meeting_poisoned",
        target,
        effect: "meeting_ruined",
        description: `${target}'s department meeting was disrupted by ${symptom}`,
        catererNote: "We are deeply sorry for any inconvenience caused by our catering",
        plausibleDeniability: "The health inspector found nothing conclusive",
        prestigeChange: -10,  // Target loses prestige
      });
    },
  },
  {
    path: "/birthday-cake",
    price: 12,
    handler: (req: Request, res: Response) => {
      const message = randomItem(cakeMessages);
      res.json({
        action: "birthday_cake_delivered",
        effect: "removes_problematic",
        description: "A surprise birthday cake appeared - how thoughtful!",
        cakeMessage: message,
        cakeFlavor: "Generic vanilla with buttercream",
        catererNote: "Everyone loves the person who brings cake",
        prestigeChange: 5,
        removesStatus: "problematic",
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
