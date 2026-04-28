/**
 * ADO PR Poller
 *
 * Runs as a background interval inside the Max daemon.  On every tick it:
 *   1. Lists open PRs in every configured repo (ADO_REPOS).
 *   2. Skips PRs that have already been reviewed (persisted in ado_reviewed_prs).
 *   3. For each new PR, marks it as reviewed immediately (idempotent) and
 *      delegates a review task to the @reviewer agent via the orchestrator.
 *
 * Configuration (all from ~/.max/.env):
 *   ADO_ORG_URL            — e.g. https://dev.azure.com/my-org
 *   ADO_PAT                — personal access token
 *   ADO_REPOS              — comma-separated "Project/Repo" pairs
 *   ADO_POLL_INTERVAL_MS   — polling frequency (default: 60 000 ms)
 */

import { listOpenPrs } from "./client.js";
import { hasPrBeenReviewed, markPrReviewed } from "../store/db.js";
import { config } from "../config.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";

let pollTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Poller core
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (!config.adoEnabled) return;

  const { adoOrgUrl, adoPat, adoRepos } = config;
  // Guard: these are always defined when adoEnabled === true
  if (!adoOrgUrl || !adoPat) return;

  for (const { project, repo } of adoRepos) {
    let prs;
    try {
      prs = await listOpenPrs(adoOrgUrl, project, repo, adoPat);
    } catch (err) {
      console.error(
        `[ado-poller] Failed to list PRs for ${project}/${repo}:`,
        err instanceof Error ? err.message : err
      );
      continue;
    }

    for (const pr of prs) {
      if (hasPrBeenReviewed(adoOrgUrl, project, repo, pr.id)) {
        continue;
      }

      // Mark before dispatching so a crash/restart doesn't trigger duplicate reviews.
      markPrReviewed(adoOrgUrl, project, repo, pr.id);

      console.log(
        `[ado-poller] New PR #${pr.id} in ${project}/${repo}: "${pr.title}" by ${pr.createdBy} — dispatching reviewer`
      );

      const task =
        `Review the following Azure DevOps pull request and post your findings as inline comments.\n\n` +
        `- **PR ID**: ${pr.id}\n` +
        `- **Repository**: ${repo}\n` +
        `- **Project**: ${project}\n` +
        `- **Title**: ${pr.title}\n` +
        `- **Author**: ${pr.createdBy}\n` +
        `- **Source branch**: ${pr.sourceRefName}\n` +
        `- **Target branch**: ${pr.targetRefName}\n\n` +
        `Steps:\n` +
        `1. Call \`get_pr_diff\` with pr_id=${pr.id}, repo="${repo}", project="${project}".\n` +
        `2. Analyse every changed file.\n` +
        `3. Call \`post_ado_review\` with a summary, per-finding inline comments, and an appropriate vote.`;

      sendToOrchestrator(
        `@reviewer ${task}`,
        { type: "background" },
        (_text, done) => {
          if (done) {
            console.log(`[ado-poller] Review of PR #${pr.id} (${project}/${repo}) complete`);
          }
        }
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** Start the ADO PR poller. No-op if ADO is not configured. */
export function startAdoPoller(): void {
  if (!config.adoEnabled) {
    console.log("[ado-poller] ADO not configured — skipping poller (set ADO_ORG_URL, ADO_PAT, ADO_REPOS)");
    return;
  }

  if (pollTimer) return; // already running

  const intervalMs = config.adoPollIntervalMs;
  console.log(
    `[ado-poller] Starting — watching ${config.adoRepos.length} repo(s) ` +
      `every ${intervalMs / 1000}s: ${config.adoRepos.map((r) => `${r.project}/${r.repo}`).join(", ")}`
  );

  // Run immediately on start, then on interval
  pollOnce().catch((err) => {
    console.error("[ado-poller] Initial poll failed:", err instanceof Error ? err.message : err);
  });

  pollTimer = setInterval(() => {
    pollOnce().catch((err) => {
      console.error("[ado-poller] Poll tick failed:", err instanceof Error ? err.message : err);
    });
  }, intervalMs);
}

/** Stop the ADO PR poller. */
export function stopAdoPoller(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = undefined;
    console.log("[ado-poller] Stopped");
  }
}
