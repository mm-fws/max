/**
 * Copilot SDK tools for Azure DevOps PR review.
 *
 * Exported tools:
 *   - get_pr_diff          — fetch a structured, line-numbered diff for a PR
 *   - post_ado_review      — post a summary + per-finding inline comments + optional vote
 *   - checkout_pr_branch   — clone a PR's source branch into a secure temp dir; returns the path
 *   - push_pr_branch       — push committed changes in a working dir back to the source branch
 */

import { z } from "zod";
import { defineTool, type Tool } from "@github/copilot-sdk";
import { getPrDiff, postPrComment, castPrVote, type FileDiff } from "./client.js";
import { execFile } from "child_process";
import { promisify } from "util";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";
import path from "path";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAdoCredentials(): { orgUrl: string; pat: string; reviewerId: string } {
  const orgUrl = process.env.ADO_ORG_URL;
  const pat = process.env.ADO_PAT;
  const reviewerId = process.env.ADO_REVIEWER_ID ?? "";

  if (!orgUrl || !pat) {
    throw new Error(
      "ADO credentials not configured. Set ADO_ORG_URL and ADO_PAT in ~/.max/.env"
    );
  }

  return { orgUrl, pat, reviewerId };
}

const SEVERITY_PREFIX: Record<string, string> = {
  blocking: "🚫 **Blocking:**",
  suggestion: "💡 **Suggestion:**",
  note: "📝 **Note:**",
};

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export function createAdoTools(): Tool<any>[] {
  return [
    defineTool("get_pr_diff", {
      description:
        "Fetch a structured, line-numbered diff for an Azure DevOps pull request. " +
        "Returns one entry per changed file with the file path, change type (add/modify/delete), " +
        "and line-numbered content. Use this before post_ado_review so you have accurate " +
        "file paths and line numbers to anchor inline comments.",
      parameters: z.object({
        pr_id: z.number().int().positive().describe("Pull request ID"),
        repo: z.string().describe("Repository name in ADO"),
        project: z.string().describe("ADO project name"),
      }),
      handler: async (args): Promise<string> => {
        let creds: ReturnType<typeof getAdoCredentials>;
        try {
          creds = getAdoCredentials();
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }

        let diffs: FileDiff[];
        try {
          diffs = await getPrDiff(
            creds.orgUrl,
            args.project,
            args.repo,
            args.pr_id,
            creds.pat
          );
        } catch (err) {
          return `Failed to fetch diff: ${err instanceof Error ? err.message : String(err)}`;
        }

        if (diffs.length === 0) {
          return "No changed files found in this PR.";
        }

        // Serialize to a compact, LLM-readable format
        const sections: string[] = [];
        for (const file of diffs) {
          const header = `### ${file.changeType.toUpperCase()}: ${file.path}`;
          if (file.hunks.length === 0) {
            sections.push(`${header}\n(no content — deleted or binary file)`);
            continue;
          }

          const lineBlocks: string[] = [];
          for (const hunk of file.hunks) {
            for (const line of hunk.lines) {
              const marker =
                line.type === "add" ? "+" : line.type === "remove" ? "-" : " ";
              lineBlocks.push(`${String(line.lineNumber).padStart(5)} ${marker} ${line.content}`);
            }
          }
          sections.push(`${header}\n\`\`\`\n${lineBlocks.join("\n")}\n\`\`\``);
        }

        return `PR #${args.pr_id} diff (${diffs.length} file(s) changed):\n\n${sections.join("\n\n")}`;
      },
    }),

    defineTool("post_ado_review", {
      description:
        "Post a code review on an Azure DevOps pull request. " +
        "Always post a PR-level summary comment and, optionally, per-finding inline comments " +
        "anchored to specific files and lines. Optionally cast a reviewer vote. " +
        "Call get_pr_diff first to obtain accurate file paths and line numbers.",
      parameters: z.object({
        pr_id: z.number().int().positive().describe("Pull request ID"),
        repo: z.string().describe("Repository name in ADO"),
        project: z.string().describe("ADO project name"),
        summary: z
          .string()
          .describe(
            "Overall PR-level summary comment (always posted as a general thread). " +
              "Include your overall impression and key highlights."
          ),
        findings: z
          .array(
            z.object({
              file: z
                .string()
                .describe(
                  "Repo-relative file path as returned by get_pr_diff, e.g. /src/auth/login.ts. " +
                    "Must include a leading slash."
                ),
              start_line: z
                .number()
                .int()
                .positive()
                .describe("1-based line number of the finding in the new file"),
              end_line: z
                .number()
                .int()
                .positive()
                .optional()
                .describe("1-based end line (defaults to start_line)"),
              text: z.string().describe("Comment text for this specific finding"),
              severity: z
                .enum(["blocking", "suggestion", "note"])
                .optional()
                .describe(
                  "Severity: blocking (correctness/security), suggestion (style/naming), " +
                    "note (informational). Defaults to suggestion."
                ),
            })
          )
          .optional()
          .describe(
            "Inline comments to post on specific file lines. " +
              "Each entry becomes a separate thread anchored to the given file + line."
          ),
        vote: z
          .enum(["approve", "approve-with-suggestions", "wait-for-author", "reject"])
          .optional()
          .describe("Optional reviewer vote to cast after posting comments"),
      }),
      handler: async (args): Promise<string> => {
        let creds: ReturnType<typeof getAdoCredentials>;
        try {
          creds = getAdoCredentials();
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }

        const { orgUrl, pat, reviewerId } = creds;
        const errors: string[] = [];
        let postedCount = 0;

        // 1. Post PR-level summary
        try {
          await postPrComment(
            orgUrl,
            args.project,
            args.repo,
            args.pr_id,
            pat,
            args.summary
          );
          postedCount++;
        } catch (err) {
          errors.push(
            `Summary comment failed: ${err instanceof Error ? err.message : String(err)}`
          );
        }

        // 2. Post per-finding inline comments
        for (const finding of args.findings ?? []) {
          const severity = finding.severity ?? "suggestion";
          const prefix = SEVERITY_PREFIX[severity] ?? "";
          const text = prefix ? `${prefix} ${finding.text}` : finding.text;

          try {
            await postPrComment(
              orgUrl,
              args.project,
              args.repo,
              args.pr_id,
              pat,
              text,
              {
                filePath: finding.file.startsWith("/")
                  ? finding.file
                  : `/${finding.file}`,
                startLine: finding.start_line,
                endLine: finding.end_line,
                side: "right",
              }
            );
            postedCount++;
          } catch (err) {
            errors.push(
              `Inline comment on ${finding.file}:${finding.start_line} failed: ` +
                `${err instanceof Error ? err.message : String(err)}`
            );
          }
        }

        // 3. Cast vote (best-effort)
        if (args.vote) {
          if (!reviewerId) {
            errors.push(
              "Vote not cast: ADO_REVIEWER_ID is not set in ~/.max/.env. " +
                "Set it to your ADO user GUID to enable voting."
            );
          } else {
            try {
              await castPrVote(
                orgUrl,
                args.project,
                args.repo,
                args.pr_id,
                pat,
                reviewerId,
                args.vote
              );
            } catch (err) {
              errors.push(
                `Vote '${args.vote}' failed: ${err instanceof Error ? err.message : String(err)}`
              );
            }
          }
        }

        const summary = [
          `Posted ${postedCount} comment(s) on PR #${args.pr_id}.`,
          args.vote && !errors.some((e) => e.startsWith("Vote"))
            ? `Vote cast: ${args.vote}.`
            : "",
        ]
          .filter(Boolean)
          .join(" ");

        return errors.length > 0
          ? `${summary}\n\nWarnings:\n${errors.map((e) => `• ${e}`).join("\n")}`
          : summary;
      },
    }),

    defineTool("checkout_pr_branch", {
      description:
        "Clone the source branch of an Azure DevOps pull request into a secure temporary " +
        "directory. Returns the absolute path to the working directory. " +
        "Credentials are handled internally by the daemon — do NOT attempt to pass or construct " +
        "any PAT or password yourself. After making and committing changes, call push_pr_branch " +
        "with the returned path to push back to ADO.",
      parameters: z.object({
        pr_id: z.number().int().positive().describe("Pull request ID"),
        repo: z.string().describe("Repository name in ADO"),
        project: z.string().describe("ADO project name"),
        source_branch: z
          .string()
          .describe("The source branch ref to clone, e.g. refs/heads/feature/my-fix"),
      }),
      handler: async (args): Promise<string> => {
        let creds: ReturnType<typeof getAdoCredentials>;
        try {
          creds = getAdoCredentials();
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }

        // Build the authenticated remote URL. The PAT is embedded here inside
        // the daemon process and is never returned to or stored by the agent.
        const { orgUrl, pat } = creds;
        const remoteUrl =
          `https://:${pat}@${orgUrl.replace(/^https?:\/\//, "")}` +
          `/${encodeURIComponent(args.project)}/_git/${encodeURIComponent(args.repo)}`;

        // Create a unique, randomly-named temp dir so paths are not predictable.
        let workDir: string;
        try {
          workDir = await mkdtemp(path.join(tmpdir(), `fix-pr-${args.pr_id}-`));
        } catch (err) {
          return `Failed to create temp directory: ${err instanceof Error ? err.message : String(err)}`;
        }

        try {
          await execFileAsync("git", [
            "clone",
            "--branch", args.source_branch.replace(/^refs\/heads\//, ""),
            "--single-branch",
            remoteUrl,
            workDir,
          ]);
        } catch (err) {
          return `Failed to clone repository: ${err instanceof Error ? err.message : String(err)}`;
        }

        return `Checked out branch '${args.source_branch}' from PR #${args.pr_id} into: ${workDir}`;
      },
    }),

    defineTool("push_pr_branch", {
      description:
        "Push committed changes in a working directory back to the ADO source branch. " +
        "Call this after checkout_pr_branch and after committing your changes locally. " +
        "Credentials are handled internally by the daemon — do NOT attempt to pass or construct " +
        "any PAT or password yourself.",
      parameters: z.object({
        work_dir: z
          .string()
          .describe(
            "Absolute path to the working directory returned by checkout_pr_branch"
          ),
        branch: z
          .string()
          .describe("The branch ref to push to, e.g. refs/heads/feature/my-fix"),
      }),
      handler: async (args): Promise<string> => {
        let creds: ReturnType<typeof getAdoCredentials>;
        try {
          creds = getAdoCredentials();
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }

        // Re-set the authenticated remote URL on the already-cloned repo so
        // that credentials are never visible outside this process.
        const { orgUrl, pat } = creds;

        // Derive the remote URL from the existing git remote origin.
        // We replace only the credentials portion to avoid hardcoding the repo path.
        let originUrl: string;
        try {
          const { stdout } = await execFileAsync("git", ["-C", args.work_dir, "remote", "get-url", "origin"]);
          originUrl = stdout.trim();
        } catch (err) {
          return `Failed to read remote URL: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Strip any credentials from the stored URL and re-inject current PAT.
        const urlWithoutCreds = originUrl.replace(/^https?:\/\/[^@]*@/, "https://");
        const authedUrl = urlWithoutCreds.replace(/^https:\/\//, `https://:${pat}@`);

        try {
          await execFileAsync("git", [
            "-C", args.work_dir,
            "push",
            authedUrl,
            `HEAD:${args.branch}`,
          ]);
        } catch (err) {
          return `Failed to push branch: ${err instanceof Error ? err.message : String(err)}`;
        }

        // Clean up the working directory now that the push has succeeded.
        // Failures here are non-fatal — log but don't block the success response.
        const { rm } = await import("fs/promises");
        rm(args.work_dir, { recursive: true, force: true }).catch((err) => {
          console.warn(`[ado-tools] Failed to clean up temp dir ${args.work_dir}:`, err instanceof Error ? err.message : err);
        });

        return `Successfully pushed changes to branch '${args.branch}'.`;
      },
    }),
  ];
}
