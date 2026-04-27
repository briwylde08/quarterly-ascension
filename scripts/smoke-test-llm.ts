import "dotenv/config";
import OpenAI from "openai";

const openai = new OpenAI({
  baseURL: process.env.OPENAI_BASE_URL,
  defaultHeaders: process.env.CF_AIG_TOKEN
    ? { "cf-aig-authorization": `Bearer ${process.env.CF_AIG_TOKEN}` }
    : undefined,
});

const systemPrompt = `You are Chad Synergize, Director of Alignment at MegaCorp Inc.

PERSONALITY:
- Aggression: 85/100
- Greed: 70/100
- Caution: 20/100
- Loyalty: 40/100

BACKSTORY: You climbed the ranks through sheer force of buzzwords and aggressive synergy.
QUIRK: You start every sentence with "Let's unpack this".
MOTIVATION: You want to be VP of Synergy by any means necessary.

You must stay in character. Decisions should reflect your personality.`;

const userPrompt = `CURRENT SITUATION (Tick 5):

YOUR STATUS:
- Prestige: 120 (Rank #3 of 10)
- Budget: $245.00 USDC
- Status Effects: None
- Allies: None

OTHER MANAGERS:
- Linda Metrics (Senior KPI Analyst): 145 prestige
- Kevin Hustle (Growth Hacker): 98 prestige
- Trevor Disrupt (Innovation Lead): 110 prestige

YOUR RECENT ACTIONS:
- Tick 3: buy_coffee → +1 productivity
- Tick 4: work → +5 prestige

AVAILABLE ACTIONS:
- work (free): Do actual work (+5 prestige)
- rest (free): Rest and recover
- schmooze [requires target]: Build relationship (may form alliance)
- buy_coffee ($8): Buy coffee (+1 productivity, removes Tired)
- file_complaint ($22) [requires target]: File HR complaint (target skips 1 action)
- strategy_report ($35): Get consultant report (+25 prestige, gives Deliverable)
- book_ceo_time ($50): Meet with CEO (+40 prestige if you have Deliverable)

INSTRUCTIONS:
Choose ONE action based on your personality. Consider your traits, budget, and rivals.

Respond with:
1. Brief reasoning (2-3 sentences, in character)
2. Your chosen action as JSON

Example:
"Per my data, this is the obvious move."

ACTION: {"type": "strategy_report"}`;

async function main() {
  console.log("Calling GPT-5.5 with sample agent prompt (Chad Synergize)...\n");

  const start = Date.now();
  const response = await openai.chat.completions.create({
    model: "openai/gpt-5.5",
    max_completion_tokens: 500,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const elapsed = ((Date.now() - start) / 1000).toFixed(2);

  const content = response.choices[0]?.message?.content ?? "";

  console.log("=== Response ===");
  console.log(content);
  console.log();

  console.log("=== Parse check ===");
  const actionMatch = content.match(/ACTION:\s*(\{[^}]+\})/i);
  if (actionMatch) {
    try {
      const action = JSON.parse(actionMatch[1]);
      console.log("OK — action parsed:", action);
    } catch (e) {
      console.log("FAIL — ACTION block found but JSON invalid:", actionMatch[1]);
    }
  } else {
    console.log("FAIL — no ACTION: pattern found in response");
  }
  console.log();

  console.log("=== Usage ===");
  const usage = response.usage;
  const inputTokens = usage?.prompt_tokens ?? 0;
  const outputTokens = usage?.completion_tokens ?? 0;
  const cost = (inputTokens * 5 + outputTokens * 30) / 1_000_000;
  console.log(`Input tokens:  ${inputTokens}`);
  console.log(`Output tokens: ${outputTokens}`);
  console.log(`Latency:       ${elapsed}s`);
  console.log(`Cost (this call): $${cost.toFixed(4)}`);
  console.log(`Projected cost per game (480 calls):  $${(cost * 480).toFixed(2)}`);
}

main().catch((err) => {
  console.error("ERROR:", err.message);
  process.exit(1);
});
