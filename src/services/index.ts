import "dotenv/config";
import { startService } from "./base.js";
import { service as coffeeCart, config as coffeeConfig } from "./coffee-cart.js";
import { service as hrDept, config as hrConfig } from "./hr-dept.js";
import { service as consultant, config as consultantConfig } from "./consultant.js";
import { service as itGuy, config as itConfig } from "./it-guy.js";
import { service as execAssistant, config as execConfig } from "./exec-assistant.js";
import { service as caterer, config as catererConfig } from "./caterer.js";
import { service as motivationalSpeaker, config as motivationalConfig } from "./motivational-speaker.js";

console.log("Starting all NPC services...\n");

// Start all services
startService(coffeeCart, coffeeConfig);
startService(hrDept, hrConfig);
startService(consultant, consultantConfig);
startService(itGuy, itConfig);
startService(execAssistant, execConfig);
startService(caterer, catererConfig);
startService(motivationalSpeaker, motivationalConfig);

console.log("\nAll NPC services running. Press Ctrl+C to stop.\n");

// Export service info for orchestrator
export const NPC_SERVICES = [
  { ...coffeeConfig, endpoints: ["/buy", "/buy-fancy"] },
  { ...hrConfig, endpoints: ["/file-complaint", "/sensitivity-training", "/check-status"] },
  { ...consultantConfig, endpoints: ["/strategy-report", "/competitive-intel", "/sabotage-plan"] },
  { ...itConfig, endpoints: ["/fix-laptop", "/recover-emails", "/calendar-conflict"] },
  { ...execConfig, endpoints: ["/book-ceo-time", "/leak-org-chart", "/schedule-conflict"] },
  { ...catererConfig, endpoints: ["/team-lunch", "/poison-meeting", "/birthday-cake"] },
  { ...motivationalConfig, endpoints: ["/book-session", "/send-to-rival"] },
];
