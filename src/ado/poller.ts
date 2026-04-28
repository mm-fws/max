/**
 * ADO PR Poller
 *
 * Runs as a background interval inside the Max daemon.  On every tick it:
 *   1. Lists open PRs in every configured repo (ADO_REPOS).
 *   2. Skips PRs that have already been reviewed (persisted in ado_reviewed_prs).
 *   3. For each new PR, marks it as reviewed immediately (idempotent) and
 *      delegates a review task to the @reviewer agent via the orchestrator.
 *   4. For every open PR (new or old), scans comment threads for the
 *      `/max:fix` trigger keyword and, when found on an unprocessed comment,
 *      dispatches the @coder agent to implement and push the fix.
 *
 * Configuration (all from ~/.max/.env):
 *   ADO_ORG_URL            — e.g. https://dev.azure.com/my-org
 *   ADO_PAT                — personal access token
 *   ADO_REPOS              — comma-separated "Project/Repo" pairs
 *   ADO_POLL_INTERVAL_MS   — polling frequency (default: 60 000 ms)
 */

import { listOpenPrs, listPrComments, postPrComment, type PrSummary } from "./client.js";
import {
  hasPrBeenReviewed,
  markPrReviewed,
  hasFixCommentBeenProcessed,
  markFixCommentProcessed,
} from "../store/db.js";
import { config } from "../config.js";
import { sendToOrchestrator } from "../copilot/orchestrator.js";
import { tmpdir } from "os";

let pollTimer: ReturnType<typeof setInterval> | undefined;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Parse a `/max:fix` trigger from a comment body.
 *
 * - Returns `null` if the keyword is not present.
 * - Returns `""` if there are no additional instructions on the trigger line.
 * - Returns the trimmed trailing text on the trigger line as additional instructions.
 *
 * Only the portion of the triggering line after `/max:fix` is returned, so
 * multi-line comments don't accidentally pass unrelated text as instructions.
 */
export function parseFixTrigger(commentText: string): string | null {
  for (const line of commentText.split("\n")) {
    const match = line.match(/\/max:fix(.*)/i);
    if (match) {
      return match[1].trim();
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Poller core
// ---------------------------------------------------------------------------

async function pollOnce(): Promise<void> {
  if (!config.adoEnabled) return;

  const { adoOrgUrl, adoPat, adoRepos } = config;
  // Guard: these are always defined when adoEnabled === true
  if (!adoOrgUrl || !adoPat) return;

  for (const { project, repo } of adoRepos) {
    let prs: PrSummary[];
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
      // --- Reviewer dispatch (new PRs only) ---
      if (!hasPrBeenReviewed(adoOrgUrl, project, repo, pr.id)) {
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

      // --- /max:fix comment scanning (all open PRs) ---
      await pollCommentsForFix(adoOrgUrl, project, repo, pr, adoPat);
    }
  }
}

/**
 * Scan comment threads on a single PR for `/max:fix` triggers and dispatch
 * the @coder agent for each unprocessed trigger found.
 */
async function pollCommentsForFix(
  adoOrgUrl: string,
  project: string,
  repo: string,
  pr: PrSummary,
  adoPat: string
): Promise<void> {
  let comments;
  try {
    comments = await listPrComments(adoOrgUrl, project, repo, pr.id, adoPat);
  } catch (err) {
    console.error(
      `[ado-poller] Failed to list comments for PR #${pr.id} in ${project}/${repo}:`,
      err instanceof Error ? err.message : err
    );
    return;
  }

  for (const comment of comments) {
    const instructions = parseFixTrigger(comment.content);
    if (instructions === null) continue; // no /max:fix in this comment

    if (hasFixCommentBeenProcessed(adoOrgUrl, project, repo, pr.id, comment.threadId, comment.commentId)) {
      continue;
    }

    // Mark as processed before dispatching to prevent duplicates on crash/restart.
    markFixCommentProcessed(adoOrgUrl, project, repo, pr.id, comment.threadId, comment.commentId);

    console.log(
      `[ado-poller] /max:fix triggered by ${comment.author} on PR #${pr.id} (${project}/${repo}) — dispatching coder`
    );

    // Sanitize user-controlled ADO fields used in markdown to prevent injection.
    const safeAuthor = comment.author.replace(/[`*_[\]]/g, "");
    const safeBranch = pr.sourceRefName.replace(/[`*_[\]]/g, "");

    // Post an immediate acknowledgement so the PR author knows the trigger was received.
    postPrComment(
      adoOrgUrl,
      project,
      repo,
      pr.id,
      adoPat,
      `🤖 **Max:** Received \`/max:fix\` trigger from @${safeAuthor}. Dispatching @coder to implement the fix on branch \`${safeBranch}\`. I'll reply here when done.`
    ).catch((err) => {
      console.warn(
        `[ado-poller] Failed to post acknowledgement for PR #${pr.id}:`,
        err instanceof Error ? err.message : err
      );
    });

    // Build the task prompt for @coder.
    // Credentials are passed via the git http.extraheader config to avoid
    // embedding the PAT directly in the clone URL, which could expose it in
    // process listings and git remote output. Note: the encoded credential will
    // still appear in process args; this is an inherent constraint when the
    // agent must run git commands non-interactively.
    const encodedPat = Buffer.from(`:${adoPat}`).toString("base64");
    const cleanRemoteUrl =
      `https://${adoOrgUrl.replace(/^https?:\/\//, "")}` +
      `/${encodeURIComponent(project)}/_git/${encodeURIComponent(repo)}`;

    // Use os.tmpdir() for cross-platform compatibility and a unique suffix to
    // prevent collisions when multiple fix tasks run concurrently.
    const workDir = `${tmpdir()}/fix-pr-${pr.id}-${Date.now().toString(36)}`;

    const additionalInstructions = instructions
      ? `Additional instructions from the commenter: ${instructions}`
      : "No additional instructions were provided beyond the trigger keyword.";

    const task =
      `You have been triggered by a /max:fix comment on an Azure DevOps pull request.\n\n` +
      `## PR Details\n` +
      `- **PR ID**: ${pr.id}\n` +
      `- **Title**: ${pr.title}\n` +
      `- **Repository**: ${repo} (Project: ${project})\n` +
      `- **Source branch**: ${pr.sourceRefName} ← push your fix here\n` +
      `- **Target branch**: ${pr.targetRefName}\n` +
      `- **PR Author**: ${pr.createdBy}\n\n` +
      `## Trigger Comment\n` +
      `Triggered by **${comment.author}**:\n` +
      `> ${comment.content.replace(/\n/g, "\n> ")}\n\n` +
      `${additionalInstructions}\n\n` +
      `## Steps\n` +
      `1. Call \`get_pr_diff\` with pr_id=${pr.id}, repo="${repo}", project="${project}" to understand the changes.\n` +
      `2. Clone the source branch from the remote (credentials are passed via git config to avoid exposing them in the URL):\n` +
      `   \`git -c http.extraheader="Authorization: Basic ${encodedPat}" clone --branch ${pr.sourceRefName} --single-branch ${cleanRemoteUrl} ${workDir}\`\n` +
      `3. Implement the requested fix inside \`${workDir}\`. Follow the existing code style and conventions.\n` +
      `4. Run any relevant tests or build steps to verify correctness.\n` +
      `5. Commit your changes with a clear message, e.g.: "fix: address /max:fix request on PR #${pr.id}"\n` +
      `6. Push the commit back to the source branch:\n` +
      `   \`git -C ${workDir} -c http.extraheader="Authorization: Basic ${encodedPat}" push origin ${pr.sourceRefName}\`\n` +
      `7. Call \`post_ado_review\` to post a PR comment summarising what was changed and why.`;

    sendToOrchestrator(
      `@coder ${task}`,
      { type: "background" },
      (_text, done) => {
        if (done) {
          console.log(`[ado-poller] Coder fix for PR #${pr.id} (${project}/${repo}) complete`);
        }
      }
    );
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
