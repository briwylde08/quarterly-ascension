// Email sending via the Cloudflare `send_email` Workers binding. No API keys,
// no fetch — the binding is bound via wrangler config. Sender domain must be
// onboarded via `wrangler email sending enable megacorp.lol` before first send.
//
// Templates live alongside the sender. They're plain strings, not React,
// to keep the runtime light.

import type { Agent, GameEvent } from "./types.js";
import { getPersona } from "./personas.js";

const FROM_EMAIL = "hr@megacorp.lol";
const FROM_NAME = "MegaCorp HR";

interface SendEmailInput {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export async function sendEmail(emailBinding: SendEmail, input: SendEmailInput): Promise<void> {
  await emailBinding.send({
    to: input.to,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: input.subject,
    html: input.html,
    text: input.text,
  });
}

// ====================================================================
// Templates
// ====================================================================

const SHELL_HEAD = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><title>MegaCorp HR</title></head>
<body style="margin:0;padding:24px;background:#f4f6fa;font-family:Calibri,'Segoe UI',Arial,sans-serif;color:#2c3e50;">
<div style="max-width:600px;margin:0 auto;background:#ffffff;border:1px solid #c8d6e5;border-top:3px solid #1c3a64;box-shadow:0 1px 4px rgba(28,58,100,0.08);">
<div style="background:linear-gradient(180deg,#1c3a64 0%,#2c5896 100%);color:#ffffff;padding:18px 24px;border-bottom:3px solid #f1c40f;">
  <div style="font-size:18px;font-weight:700;letter-spacing:0.5px;">▸ MegaCorp Inc.</div>
  <div style="font-size:11px;color:rgba(255,255,255,0.75);text-transform:uppercase;letter-spacing:1.5px;margin-top:2px;">
    Confidential · Internal Distribution Only
  </div>
</div>
<div style="padding:24px;">`;

const SHELL_FOOT = `</div>
<div style="background:#ecf0f1;padding:12px 24px;border-top:1px solid #c8d6e5;font-size:11px;color:#7a8b99;">
  Sent by MegaCorp HR Systems. Do not reply directly.<br>
  <a href="https://quarterly-ascension.pages.dev/" style="color:#2471a3;">View live operations dashboard</a>
</div>
</div>
</body></html>`;

function statusLine(agent: Agent, balance: number, rank: number, total: number): string {
  const status = agent.statusEffects.length > 0
    ? agent.statusEffects.map((s) => s.type.toUpperCase().replace(/_/g, " ")).join(" · ")
    : "NORMAL";
  return `Status: ${status} | Budget: $${balance.toFixed(0)} | Prestige: ${agent.prestige} (#${rank} of ${total})`;
}

// --- Claim confirmation -----------------------------------------------------

export function claimConfirmationEmail(opts: {
  agent: Agent;
  balance: number;
  rank: number;
  total: number;
  claimerName: string;
}): SendEmailInput {
  const { agent, balance, rank, total, claimerName } = opts;
  const persona = getPersona(agent.personaId);
  const traits = persona?.traits;
  const traitsText = traits
    ? `Aggression ${traits.aggression} · Greed ${traits.greed} · Caution ${traits.caution} · Loyalty ${traits.loyalty}`
    : "";

  const text = [
    `Welcome to MegaCorp, ${claimerName}.`,
    ``,
    `You've been assigned ${agent.name}, ${agent.title}.`,
    `${statusLine(agent, balance, rank, total)}`,
    traitsText ? `Personality profile: ${traitsText}` : "",
    persona?.backstory ? `Backstory: ${persona.backstory}` : "",
    persona?.quirk ? `Quirk: ${persona.quirk}` : "",
    ``,
    `You'll receive performance summaries each quarter, then a final outcome at end-of-cycle.`,
    `Live dashboard: https://quarterly-ascension.pages.dev/`,
    `Your manager's profile: https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}`,
    ``,
    `— MegaCorp HR Systems`,
  ].filter(Boolean).join("\n");

  const html = `${SHELL_HEAD}
  <h2 style="margin:0 0 8px;color:#1c3a64;font-size:20px;">Welcome to MegaCorp, ${escapeHtml(claimerName)}</h2>
  <div style="font-size:13px;color:#7a8b99;margin-bottom:16px;">Your assignment is confirmed.</div>

  <div style="background:#dce9f5;color:#1c3a64;padding:10px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:0;border:1px solid #c8d6e5;border-bottom:0;">
    Manager Profile
  </div>
  <div style="border:1px solid #c8d6e5;padding:18px;margin-bottom:18px;">
    <div style="font-size:18px;font-weight:700;color:#1c3a64;">${escapeHtml(agent.name)}</div>
    <div style="font-size:13px;color:#7a8b99;margin-bottom:10px;">${escapeHtml(agent.title)}</div>
    <div style="font-size:12px;font-family:monospace;background:#f4f6fa;padding:8px 10px;margin-bottom:10px;">${escapeHtml(statusLine(agent, balance, rank, total))}</div>
    ${traits ? `<div style="font-size:12px;margin-bottom:8px;"><b>Personality:</b> ${traitsText}</div>` : ""}
    ${persona?.backstory ? `<div style="font-size:13px;margin-bottom:6px;"><b>Backstory:</b> ${escapeHtml(persona.backstory)}</div>` : ""}
    ${persona?.quirk ? `<div style="font-size:13px;color:#7a8b99;font-style:italic;">"${escapeHtml(persona.quirk)}"</div>` : ""}
  </div>

  <p style="font-size:13px;line-height:1.6;">
    You'll receive a quarterly performance summary at cycles 12, 24, and 36, plus a final outcome report at cycle 48. There is nothing to do — your manager will make their own decisions, on the corporate testnet, with real on-chain payments.
  </p>

  <p style="margin-top:18px;">
    <a href="https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}" style="background:#1c3a64;color:#ffffff;padding:10px 18px;text-decoration:none;font-size:13px;letter-spacing:0.5px;">View ${escapeHtml(agent.name.split(" ")[0])}'s profile</a>
    &nbsp;
    <a href="https://quarterly-ascension.pages.dev/" style="color:#2471a3;font-size:13px;">Or watch live →</a>
  </p>
${SHELL_FOOT}`;

  return {
    to: "", // caller fills in
    subject: `Your MegaCorp assignment: ${agent.name}`,
    html,
    text,
  };
}

// --- HR-flavored commentary bank, keyed by action type --------------------
// Each entry is a pool of 2 dry-corporate one-liners that get injected as a
// sub-bullet under each activity. Picked at random per call so a manager who
// did the same action 3 times doesn't get 3 identical commentaries.
const HR_COMMENTARY: Record<string, string[]> = {
  work: [
    "Visible. Q3 alignment retained.",
    "Hands-on contribution detected — rare these days.",
  ],
  rest: [
    "Reportedly 'recharging.' We allow it.",
    "PTO-adjacent. Not technically taken.",
  ],
  schmooze: [
    "Strategic relationship-building. The cafeteria has cameras.",
    "Coffee-grade networking. Confluence pending.",
  ],
  buy_coffee: [
    "Routine caffeine procurement. Logged.",
    "Standard-issue corporate fuel.",
  ],
  buy_fancy_coffee: [
    "Pour-over acquired. The cup itself is trying to network.",
    "$15 espresso drink with self-reported productivity gain.",
  ],
  file_complaint: [
    "Formal HR filing. Adjudication pending.",
    "Slack-screenshot-grade complaint registered.",
  ],
  sensitivity_training: [
    "Three-hour workshop enrolled. No break.",
    "Mandatory growth opportunity assigned.",
  ],
  check_hr_status: [
    "Defensive paperwork audit complete.",
    "Self-PII inquiry. Comprehensive.",
  ],
  strategy_report: [
    "Deliverable acquired. Pull-through energy.",
    "Consultant report filed in the official binder.",
  ],
  competitive_intel: [
    "Reconnaissance executed. Information asymmetry restored.",
    "Skimmed the others' decks. They are not impressive.",
  ],
  sabotage_plan: [
    "Dossier compiled. Filed in the desk drawer for later use.",
    "Opposition research paid in full.",
  ],
  fix_laptop: [
    "Target's laptop receives 'maintenance.' Downtime: 1 cycle.",
    "IT escalation initiated. Mysterious BSODs ensue.",
  ],
  recover_emails: [
    "Forensic recovery successful. The receipts are something.",
    "Old inbox traces salvaged from the void.",
  ],
  calendar_conflict: [
    "Calendar Tetris executed. Target's morning now overbooked.",
    "Three meetings, one slot. Outlook will not be sorting it out.",
  ],
  leak_org_chart: [
    "Insider info procured. The wealth ranking is illuminating.",
    "Org chart with un-redacted compensation data acquired.",
  ],
  schedule_conflict: [
    "Their CEO meeting reflows. The invite has 'vanished.'",
    "Calendar dispatch successful. Confusion engineered.",
  ],
  team_lunch: [
    "Catered lunch hosted. Goodwill modestly inflated.",
    "Free food: the reliable prestige multiplier.",
  ],
  poison_meeting: [
    "The shrimp was 'off.' Coincidence, surely.",
    "Catering compromised. Their meeting concluded earlier than planned.",
  ],
  birthday_cake: [
    "Cake brought. Reputation rehabilitation, ~$12 retail.",
    "Sheet cake from Costco. No one suspects strategic intent.",
  ],
  book_motivation: [
    "Inspirational session attended. You are now caffeinated by mantras.",
    "Motivational speaker booked. You came back with bullet points.",
  ],
  send_motivation: [
    "Target sent to seminar. They will not return inspired.",
    "Mandatory four-hour mantra immersion assigned.",
  ],
  accept_alliance: [
    "Alliance formalized. Strategic synergy bloc consolidated.",
    "Strategic partnership recognized in writing.",
  ],
  reject_alliance: [
    "Alliance offer declined. Visibility hit registered.",
    "RSVP'd 'no thanks' to the partnership invite.",
  ],
  break_alliance: [
    "Alliance dissolved. Cold-shoulder dynamics begin.",
    "Strategic synergy partnership formally rescinded.",
  ],
  mentorship: [
    "Mentorship cred logged. Pay-It-Forward stipend disbursed.",
    "Senior-to-junior visibility play. Stipend included.",
  ],
  coffee_chat: [
    "Mutual visibility achieved. Low-stakes networking.",
    "Casual catch-up. Neither party committed to anything.",
  ],
};

function pickFlavor<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

function hrCommentary(actionType: string, outcome: string): string {
  // Outcome-dependent action types — pick from success vs failure pool.
  if (actionType === "take_credit") {
    return outcome.toLowerCase().startsWith("successfully")
      ? pickFlavor([
          "Re-attribution successful. Confluence updated retroactively.",
          "Credit transfer cleared. The Slack thread is mysteriously empty.",
        ])
      : pickFlavor([
          "Credit-transfer attempt rejected. Receipts and timestamps invoked.",
          "Counterparty produced a Notion doc. Audit was humiliating.",
        ]);
  }
  if (actionType === "book_ceo_time") {
    if (outcome.toLowerCase().includes("blocked")) {
      return "Calendar collision. Meeting cancelled before it could start.";
    }
    return outcome.toLowerCase().includes("successful")
      ? pickFlavor([
          "CEO visibly nodded. Q-rating up.",
          "Right slide at the right time. Executive sponsorship assumed.",
        ])
      : pickFlavor([
          "CEO meeting concluded in awkward silence. Empty-handed.",
          "30 minutes of small talk and no deck. Painful.",
        ]);
  }
  if (actionType === "whistleblower_bounty") {
    return outcome.toLowerCase().includes("paid") || outcome.toLowerCase().includes("flagged")
      ? pickFlavor([
          "Whistleblower bounty disbursed. Receipts checked.",
          "Substantiated report. HR very pleased.",
        ])
      : pickFlavor([
          "Whistleblower report dismissed. HR very disappointed.",
          "False report filed. Sympathy bonus issued to target.",
        ]);
  }

  const pool = HR_COMMENTARY[actionType];
  if (!pool || pool.length === 0) return "";
  return pickFlavor(pool);
}

// --- Progress summary (ticks 12, 24, 36) -----------------------------------

export interface ProgressSummaryInput {
  agent: Agent;
  balance: number;
  rank: number;
  total: number;
  claimerName: string;
  claimerEmail: string;           // used to build the coaching deep-link
  cycle: number;
  cycleLabel: string;             // e.g. "Q1 Cycle 24 (mid-quarter)"
  actions: Array<{ tick: number; action_type: string; outcome: string; reasoning: string | null; prestige_change: number | null }>;
  inboundEvents: Array<{ tick: number; description: string }>;  // events targeting this agent
  prestigeStart: number;
  budgetStart: number;
  notableQuotes: string[];
}

export function progressSummaryEmail(opts: ProgressSummaryInput): SendEmailInput {
  const { agent, balance, rank, total, claimerName, claimerEmail, cycle, cycleLabel, actions, inboundEvents, prestigeStart, budgetStart, notableQuotes } = opts;

  const prestigeDelta = agent.prestige - prestigeStart;
  const budgetDelta = balance - budgetStart;
  const arrowUp = "📈"; const arrowDown = "📉"; const warning = "⚠️"; const sparkle = "✨";

  const highlights: string[] = [];
  if (prestigeDelta > 0) highlights.push(`${arrowUp} Prestige up ${prestigeDelta} (now ${agent.prestige}, rank #${rank})`);
  else if (prestigeDelta < 0) highlights.push(`${arrowDown} Prestige down ${Math.abs(prestigeDelta)} (now ${agent.prestige}, rank #${rank})`);
  else highlights.push(`Prestige flat at ${agent.prestige} (rank #${rank})`);

  if (budgetDelta > 0) highlights.push(`${arrowUp} Budget up $${budgetDelta.toFixed(0)} — earning more than spending`);
  else if (budgetDelta < -10) highlights.push(`${arrowDown} Budget down $${Math.abs(budgetDelta).toFixed(0)} — spending aggressively`);

  if (inboundEvents.length > 0) {
    highlights.push(`${warning} ${inboundEvents.length} event(s) targeted you this period`);
  }

  if (notableQuotes.length > 0 && agent.statusEffects.some((s) => s.type === "inspired")) {
    highlights.push(`${sparkle} Currently Inspired — gaining +5/cycle automatically`);
  }

  // Each activity now has a main fact-line and an HR-commentary sub-line.
  // The commentary picks from action-type-specific flavor pools so a manager
  // who did `work` three times in a period gets three different observations.
  const activityItems = actions.length === 0
    ? [{ main: "No notable activity this period.", commentary: "" }]
    : actions.slice(0, 8).map((a) => {
        const sign = a.prestige_change !== null && a.prestige_change !== 0
          ? ` (${a.prestige_change > 0 ? "+" : ""}${a.prestige_change} prestige)`
          : "";
        return {
          main: `${a.action_type}${sign} — ${a.outcome.slice(0, 140)}`,
          commentary: hrCommentary(a.action_type, a.outcome),
        };
      });
  const activityLines = activityItems.map((it) =>
    it.commentary ? `• ${it.main}\n   ↳ ${it.commentary}` : `• ${it.main}`
  );

  const quoteLines = notableQuotes.length > 0
    ? notableQuotes.slice(0, 3).map((q) => `"${q}"`)
    : ['"No memorable statements on record."'];

  const outlook = generateOutlook(agent, prestigeDelta, budgetDelta, balance, rank, total);

  const coachUrl = `https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}&email=${encodeURIComponent(claimerEmail)}#coach`;
  const text = [
    `${cycleLabel} Performance Summary — ${agent.name}`,
    `${"━".repeat(60)}`,
    `${agent.name} — ${agent.title}`,
    statusLine(agent, balance, rank, total),
    ``,
    `THIS PERIOD'S ACTIVITIES:`,
    ...activityLines,
    ``,
    `HIGHLIGHTS:`,
    ...highlights.map((h) => ` ${h}`),
    ``,
    `NOTABLE QUOTES:`,
    ...quoteLines.map((q) => ` ${q}`),
    ``,
    `NEXT PERIOD OUTLOOK:`,
    outlook,
    ``,
    `⏱ COACHING — one directive credit for next quarter, set it any time before the next email:`,
    `   ${coachUrl}`,
    ``,
    `Live dashboard: https://quarterly-ascension.pages.dev/`,
    `Profile: https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}`,
  ].join("\n");

  const html = `${SHELL_HEAD}
  <h2 style="margin:0 0 4px;color:#1c3a64;font-size:18px;">${escapeHtml(cycleLabel)} Performance Summary</h2>
  <div style="font-size:14px;font-weight:600;color:#2c3e50;">${escapeHtml(agent.name)} — ${escapeHtml(agent.title)}</div>
  <div style="font-size:12px;font-family:monospace;background:#f4f6fa;padding:8px 10px;margin:10px 0 18px;">${escapeHtml(statusLine(agent, balance, rank, total))}</div>

  <div style="background:#dce9f5;color:#1c3a64;padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:0;border:1px solid #c8d6e5;border-bottom:0;">This period's activities</div>
  <ul style="margin:0;padding:14px 18px 14px 32px;border:1px solid #c8d6e5;font-size:13px;line-height:1.6;">
    ${activityItems.map((it) => `
      <li style="margin-bottom:10px;">
        <div>${escapeHtml(it.main)}</div>
        ${it.commentary ? `<div style="font-style:italic;color:#7a8b99;font-size:11px;margin-top:3px;letter-spacing:0.2px;">↳ ${escapeHtml(it.commentary)}</div>` : ""}
      </li>`).join("")}
  </ul>

  <div style="background:#dce9f5;color:#1c3a64;padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin:18px 0 0;border:1px solid #c8d6e5;border-bottom:0;">Highlights</div>
  <ul style="margin:0;padding:14px 18px 14px 32px;border:1px solid #c8d6e5;font-size:13px;line-height:1.7;list-style:none;">
    ${highlights.map((h) => `<li style="margin-bottom:4px;">${escapeHtml(h)}</li>`).join("")}
  </ul>

  <div style="background:#dce9f5;color:#1c3a64;padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin:18px 0 0;border:1px solid #c8d6e5;border-bottom:0;">Notable quotes</div>
  <ul style="margin:0;padding:14px 18px 14px 32px;border:1px solid #c8d6e5;font-size:13px;line-height:1.7;list-style:none;font-style:italic;color:#2c3e50;">
    ${quoteLines.map((q) => `<li style="margin-bottom:6px;">${escapeHtml(q)}</li>`).join("")}
  </ul>

  <div style="background:#dce9f5;color:#1c3a64;padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin:18px 0 0;border:1px solid #c8d6e5;border-bottom:0;">Next period outlook</div>
  <div style="border:1px solid #c8d6e5;padding:14px 18px;font-size:13px;line-height:1.6;">
    ${escapeHtml(outlook)}
  </div>

  <div style="background:#fef5e7;border:1px solid #f1c40f;padding:14px 18px;margin-top:18px;font-size:13px;line-height:1.5;">
    <b style="color:#1c3a64;">⏱ Want to course-correct?</b>
    You have one directive credit for next quarter — give ${escapeHtml(agent.name.split(" ")[0])} a strategic note any time before the next progress email lands. One coach per quarter.
    <br><br>
    <a href="https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}&email=${encodeURIComponent(claimerEmail)}#coach" style="background:#1c3a64;color:#ffffff;padding:10px 18px;text-decoration:none;font-size:13px;letter-spacing:0.5px;">Coach ${escapeHtml(agent.name.split(" ")[0])} →</a>
  </div>

  <p style="margin-top:22px;">
    <a href="https://quarterly-ascension.pages.dev/agent.html?id=${agent.id}" style="background:#7a8b99;color:#ffffff;padding:8px 16px;text-decoration:none;font-size:12px;letter-spacing:0.5px;">View profile</a>
    &nbsp;
    <a href="https://quarterly-ascension.pages.dev/" style="color:#2471a3;font-size:13px;">Watch live →</a>
  </p>
${SHELL_FOOT}`;

  return {
    to: "",
    subject: `${cycleLabel} Performance Summary — ${agent.name}`,
    html,
    text,
  };
}

// --- Finale (tick 48) -------------------------------------------------------

export interface FinaleInput {
  agent: Agent;
  balance: number;
  finalRank: number;
  total: number;
  claimerName: string;
  winnerName: string;
  isWinner: boolean;
  notableQuotes: string[];
  totalPaidActions: number;
}

export function finaleEmail(opts: FinaleInput): SendEmailInput {
  const { agent, balance, finalRank, total, claimerName, winnerName, isWinner, notableQuotes, totalPaidActions } = opts;
  const headline = isWinner
    ? `🏆 ${agent.name} IS THE NEW VP`
    : `Q1 Final Results — ${agent.name} closes at #${finalRank}`;

  const body = isWinner
    ? `${agent.name} ascended through ${totalPaidActions} on-chain corporate maneuvers this quarter. The board is "thrilled." The break room cake will be delivered next Tuesday.`
    : `${winnerName} took the VP slot. ${agent.name} held the line at rank #${finalRank} of ${total} — ${rankFlavor(finalRank, total)}.`;

  const text = [
    headline,
    `${"━".repeat(60)}`,
    body,
    ``,
    `Final stats:`,
    statusLine(agent, balance, finalRank, total),
    ``,
    `Memorable quotes from ${agent.name} this quarter:`,
    ...notableQuotes.slice(0, 5).map((q) => `  "${q}"`),
    ``,
    `Live dashboard (now closed): https://quarterly-ascension.pages.dev/`,
  ].join("\n");

  const html = `${SHELL_HEAD}
  <h1 style="margin:0 0 6px;color:${isWinner ? "#27ae60" : "#1c3a64"};font-size:22px;">${escapeHtml(headline)}</h1>
  <div style="font-size:13px;color:#7a8b99;margin-bottom:18px;">Quarter has officially closed.</div>

  <p style="font-size:14px;line-height:1.6;">
    ${escapeHtml(body)}
  </p>

  <div style="font-size:12px;font-family:monospace;background:#f4f6fa;padding:10px 14px;margin:18px 0;border:1px solid #c8d6e5;">
    ${escapeHtml(statusLine(agent, balance, finalRank, total))}
  </div>

  <div style="background:#dce9f5;color:#1c3a64;padding:8px 14px;font-size:12px;text-transform:uppercase;letter-spacing:1px;font-weight:600;margin-bottom:0;border:1px solid #c8d6e5;border-bottom:0;">Memorable quotes</div>
  <ul style="margin:0;padding:14px 18px 14px 32px;border:1px solid #c8d6e5;font-size:13px;line-height:1.7;list-style:none;font-style:italic;">
    ${notableQuotes.slice(0, 5).map((q) => `<li style="margin-bottom:6px;">"${escapeHtml(q)}"</li>`).join("")}
  </ul>

  <p style="margin-top:22px;font-size:13px;color:#7a8b99;">
    Thanks for adopting a manager. Your participation has been logged in the corporate intranet.
  </p>
${SHELL_FOOT}`;

  return {
    to: "",
    subject: isWinner ? `🏆 ${agent.name} won Q1` : `Q1 Closed — ${agent.name} at #${finalRank}`,
    html,
    text,
  };
}

// --- Helpers ----------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function generateOutlook(agent: Agent, prestigeDelta: number, budgetDelta: number, balance: number, rank: number, total: number): string {
  if (rank === 1) return `${agent.name} is in the lead. Rivals will be circling — expect more incoming sabotage. Maintaining the lead requires Deliverables and a healthy budget.`;
  if (rank <= 3) return `${agent.name} is in striking distance of VP. Budget allowing, a CEO meeting could close the gap.`;
  if (prestigeDelta > 20) return `${agent.name} is on a strong upswing. The trajectory is right, the question is whether the budget can sustain it.`;
  if (prestigeDelta < -20) return `${agent.name} took serious damage this period. Birthday cake or sympathy plays may help; another bad cycle puts VP out of reach.`;
  if (balance < 30) return `${agent.name}'s discretionary budget is running low. Free actions (work, schmooze, take_credit) only for the foreseeable future.`;
  if (rank >= total - 2) return `${agent.name} is in the bottom third. A high-variance play (take_credit, viral LinkedIn ambitions, alliance betrayal) is statistically advised.`;
  return `${agent.name} is holding steady mid-pack. Time to pick a strategy — coast on free actions or commit to a paid push toward the CEO.`;
}

function rankFlavor(rank: number, total: number): string {
  if (rank === 2) return "a respectable runner-up. The board calls this 'second chair.' HR calls it 'developing leadership material.'";
  if (rank === 3) return "podium finish. Bronze medal in corporate ambition.";
  if (rank <= total / 2) return "above the median. The performance review will use the word 'solid.'";
  if (rank === total) return "dead last. Not technically a fireable offense, but probably reorg-relevant.";
  return "below the median. The phrase 'opportunities for growth' will appear in your review.";
}
