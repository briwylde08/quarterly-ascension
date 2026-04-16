import { Request, Response } from "express";
import { createNpcService, startService, ServiceConfig } from "./base.js";

const config: ServiceConfig = {
  name: "Motivational Speaker",
  port: 3016,
  recipientAddress: process.env.MOTIVATIONAL_SPEAKER_ADDRESS || "",
};

const speakerNames = [
  "Brad Momentum",
  "Crystal Hustle",
  "Derek Grindstone",
  "Tiffany Uplift",
  "Chad Inspiration",
];

const motivationalQuotes = [
  "Success is just failure that hasn't given up yet!",
  "Be the synergy you wish to see in the world!",
  "Your comfort zone is a beautiful place, but nothing grows there!",
  "Dream bigger! Then dream even bigger! Now TRIPLE IT!",
  "The only thing standing between you and success is... everything!",
  "Turn your wounds into wisdom, and your wisdom into a TED talk!",
  "You miss 100% of the shots you don't take, and also about 90% of the ones you do!",
  "If opportunity doesn't knock, build a door! Then monetize the door!",
];

const sessionTitles = [
  "Unleashing Your Inner Champion",
  "From Good to Great to LEGENDARY",
  "The 7 Habits of Highly Synergistic People",
  "Mindset Mastery: Think It, Be It, Invoice It",
  "Crushing It: A Journey to Excellence",
];

function randomItem<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

const service = createNpcService(config, [
  {
    path: "/book-session",
    price: 30,
    handler: (req: Request, res: Response) => {
      const speaker = randomItem(speakerNames);
      const quote = randomItem(motivationalQuotes);
      const title = randomItem(sessionTitles);
      res.json({
        action: "motivation_session_attended",
        effect: "inspired",
        description: `Attended "${title}" with ${speaker}`,
        speaker,
        sessionTitle: title,
        keyTakeaway: quote,
        speakerNote: "Remember: you are ENOUGH! (But could always be more)",
        prestigeChange: 20,
        statusEffect: {
          type: "inspired",
          duration: 2,  // +5 prestige per tick for 2 ticks
        },
      });
    },
  },
  {
    path: "/send-to-rival",
    price: 35,
    handler: (req: Request, res: Response) => {
      const { target } = req.body;
      const speaker = randomItem(speakerNames);
      const title = randomItem(sessionTitles);
      res.json({
        action: "mandatory_motivation_assigned",
        target,
        effect: "wasted_actions",
        description: `${target} has been enrolled in mandatory motivation training`,
        speaker,
        sessionTitle: title,
        speakerNote: "They seemed... resistant to growth. We'll work on that.",
        hrJustification: "We noticed some opportunities for personal development",
        statusEffect: {
          type: "mandatory_motivation",
          target,
          duration: 2,  // Wastes next 2 actions
        },
      });
    },
  },
]);

export { service, config };

if (import.meta.url === `file://${process.argv[1]}`) {
  startService(service, config);
}
