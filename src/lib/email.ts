import { Resend } from "resend";
import { Agent, HourlyReport, ActionSummary, TransactionSummary } from "./types.js";
import { getAllAgents, getAgentActionLogs, getCurrentTick } from "./db.js";
import { getAssetBalance, getExplorerTxUrl, getExplorerAccountUrl } from "./stellar.js";

const resend = new Resend(process.env.RESEND_API_KEY);
const FROM_EMAIL = process.env.FROM_EMAIL || "hr-notifications@megacorp.internal";

/**
 * Generate and send hourly reports to all players
 */
export async function sendHourlyReports(tickStart: number, tickEnd: number): Promise<void> {
  const agents = getAllAgents();
  const allAgentsSorted = agents.sort((a, b) => b.prestige - a.prestige);

  for (const agent of agents) {
    if (!agent.claimedBy) continue; // Skip unclaimed agents

    const rank = allAgentsSorted.findIndex((a) => a.id === agent.id) + 1;
    const balance = await getAssetBalance(agent.publicKey);
    const actionLogs = getAgentActionLogs(agent.id, tickStart, tickEnd);

    const report: HourlyReport = {
      agentId: agent.id,
      agentName: agent.name,
      playerEmail: agent.claimedBy,
      playerName: agent.claimedByName || "Player",
      tickRange: [tickStart, tickEnd],
      prestige: agent.prestige,
      prestigeRank: rank,
      budget: balance,
      actions: actionLogs.map((log) => ({
        tick: log.tick,
        action: log.action_type,
        cost: 0, // Would need to track this
        outcome: log.outcome,
        quote: log.reasoning,
      })),
      rivals: [], // Could track this
      allies: agent.allies,
      statusEffects: agent.statusEffects.map((e) => e.type),
      notableQuotes: actionLogs.slice(0, 3).map((l) => l.reasoning).filter(Boolean),
      complaints: [], // Would need to track
      transactions: actionLogs
        .filter((l) => l.tx_hash)
        .map((l) => ({
          tick: l.tick,
          service: l.action_type,
          amount: 0, // Would need to track
          txHash: l.tx_hash,
          explorerUrl: getExplorerTxUrl(l.tx_hash),
        })),
    };

    await sendReport(report);
  }
}

/**
 * Send a single report email
 */
async function sendReport(report: HourlyReport): Promise<void> {
  const emailHtml = generateReportHtml(report);

  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: report.playerEmail,
      subject: `🏢 Q1 Performance Summary - Your Agent: ${report.agentName}`,
      html: emailHtml,
    });
    console.log(`Sent report to ${report.playerEmail} for ${report.agentName}`);
  } catch (error) {
    console.error(`Failed to send report to ${report.playerEmail}:`, error);
  }
}

/**
 * Generate the HTML for a report email
 */
function generateReportHtml(report: HourlyReport): string {
  const statusLine = report.statusEffects.length > 0
    ? report.statusEffects.join(", ")
    : "Normal";

  const actionsHtml = report.actions.length > 0
    ? report.actions.map((a) => `
        <tr>
          <td style="padding: 8px; border-bottom: 1px solid #333;">Tick ${a.tick}</td>
          <td style="padding: 8px; border-bottom: 1px solid #333;">${a.action}</td>
          <td style="padding: 8px; border-bottom: 1px solid #333;">${a.outcome}</td>
        </tr>
      `).join("")
    : '<tr><td colspan="3" style="padding: 8px; color: #888;">No actions this period</td></tr>';

  const quotesHtml = report.notableQuotes.length > 0
    ? report.notableQuotes.map((q) => `<li style="margin-bottom: 8px; font-style: italic;">"${q}"</li>`).join("")
    : '<li style="color: #888;">No notable quotes</li>';

  const txHtml = report.transactions.length > 0
    ? report.transactions.map((t) => `
        <li style="margin-bottom: 8px;">
          ${t.service}: <a href="${t.explorerUrl}" style="color: #00ccff;">${t.txHash.slice(0, 8)}...</a>
        </li>
      `).join("")
    : '<li style="color: #888;">No transactions this period</li>';

  return `
<!DOCTYPE html>
<html>
<head>
  <style>
    body { font-family: 'Courier New', monospace; background: #0a0a0a; color: #00ff00; padding: 20px; }
    .container { max-width: 600px; margin: 0 auto; background: #111; border: 1px solid #333; padding: 20px; }
    .header { border-bottom: 2px solid #333; padding-bottom: 15px; margin-bottom: 20px; }
    .title { font-size: 18px; color: #888; }
    .agent-name { font-size: 24px; font-weight: bold; margin: 10px 0; }
    .stats { display: flex; gap: 30px; margin: 20px 0; }
    .stat { text-align: center; }
    .stat-value { font-size: 28px; font-weight: bold; }
    .stat-label { font-size: 12px; color: #888; }
    .section { margin: 20px 0; }
    .section-title { font-size: 14px; color: #888; border-bottom: 1px solid #333; padding-bottom: 5px; margin-bottom: 10px; }
    table { width: 100%; border-collapse: collapse; }
    th { text-align: left; padding: 8px; color: #888; border-bottom: 1px solid #333; }
    .footer { margin-top: 30px; padding-top: 15px; border-top: 1px solid #333; font-size: 11px; color: #666; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <div class="title">MEGACORP INC. - CONFIDENTIAL PERFORMANCE DATA</div>
      <div class="agent-name">${report.agentName}</div>
      <div style="color: #888;">${report.tickRange[0]} - ${report.tickRange[1]} ticks</div>
    </div>

    <div class="stats">
      <div class="stat">
        <div class="stat-value">#${report.prestigeRank}</div>
        <div class="stat-label">RANK</div>
      </div>
      <div class="stat">
        <div class="stat-value">${report.prestige}</div>
        <div class="stat-label">PRESTIGE</div>
      </div>
      <div class="stat">
        <div class="stat-value" style="color: ${report.budget < 50 ? '#ff4444' : '#ffcc00'};">$${report.budget.toFixed(0)}</div>
        <div class="stat-label">BUDGET</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">STATUS</div>
      <div>${statusLine}</div>
    </div>

    <div class="section">
      <div class="section-title">ALLIES</div>
      <div>${report.allies.length > 0 ? report.allies.join(", ") : "None"}</div>
    </div>

    <div class="section">
      <div class="section-title">THIS PERIOD'S ACTIVITIES</div>
      <table>
        <tr>
          <th>When</th>
          <th>Action</th>
          <th>Outcome</th>
        </tr>
        ${actionsHtml}
      </table>
    </div>

    <div class="section">
      <div class="section-title">NOTABLE QUOTES</div>
      <ul style="margin: 0; padding-left: 20px;">
        ${quotesHtml}
      </ul>
    </div>

    <div class="section">
      <div class="section-title">STELLAR TRANSACTIONS</div>
      <ul style="margin: 0; padding-left: 20px;">
        ${txHtml}
      </ul>
    </div>

    <div class="footer">
      This is an automated message from HR Systems. Do not reply to this email.<br><br>
      Powered by <span style="color: #00ff00;">Quarterly Ascension</span> · Real payments on Stellar
    </div>
  </div>
</body>
</html>
  `;
}

/**
 * Send game end summary
 */
export async function sendGameEndSummary(): Promise<void> {
  const agents = getAllAgents();
  const winner = agents.sort((a, b) => b.prestige - a.prestige)[0];

  for (const agent of agents) {
    if (!agent.claimedBy) continue;

    const isWinner = agent.id === winner.id;
    const subject = isWinner
      ? `🏆 CONGRATULATIONS! ${agent.name} is the new VP!`
      : `📊 Final Results - ${agent.name}'s Q1 Performance`;

    // Would send a final summary email here
    console.log(`Would send final summary to ${agent.claimedBy}: ${subject}`);
  }
}
