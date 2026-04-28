/**
 * Lightweight Azure DevOps REST client.
 *
 * Only the operations needed by the reviewer agent are implemented:
 *   - postPrComment   — post a PR-level or inline-thread comment
 *   - castPrVote      — submit a reviewer vote on a PR
 *   - getPrDiff       — fetch a structured diff for a PR
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface InlineLocation {
  /** Repo-relative path with a leading slash, e.g. "/src/auth/login.ts". */
  filePath: string;
  /** 1-based start line on the target side. */
  startLine: number;
  /** 1-based end line on the target side (defaults to startLine). */
  endLine?: number;
  /** Which side of the diff to anchor the comment to. Default: "right" (new file). */
  side?: "right" | "left";
}

export interface DiffLine {
  lineNumber: number;
  content: string;
  type: "add" | "context" | "remove";
}

export interface DiffHunk {
  newStart: number;
  lines: DiffLine[];
}

export interface FileDiff {
  path: string;
  changeType: "add" | "modify" | "delete";
  hunks: DiffHunk[];
}

// ADO vote values
const VOTE_MAP: Record<string, number> = {
  approve: 10,
  "approve-with-suggestions": 5,
  "wait-for-author": -5,
  reject: -10,
};

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function adoRequest(
  url: string,
  pat: string,
  method: "GET" | "POST" | "PUT" | "PATCH",
  body?: unknown
): Promise<unknown> {
  const token = btoa(`:${pat}`);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Basic ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`ADO ${method} ${url} → ${res.status} ${res.statusText}: ${text}`);
  }

  // 204 No Content
  if (res.status === 204) return null;

  return res.json();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Post a comment thread on a PR.
 *
 * When `inline` is provided the thread is anchored to the given file / line.
 * When omitted the comment becomes a PR-level (general) thread.
 */
export async function postPrComment(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  pat: string,
  text: string,
  inline?: InlineLocation
): Promise<void> {
  const url =
    `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests/${prId}/threads?api-version=7.1`;

  const side = inline?.side ?? "right";
  const startLine = inline?.startLine ?? 1;
  const endLine = inline?.endLine ?? startLine;

  const threadContext = inline
    ? {
        filePath: inline.filePath.startsWith("/")
          ? inline.filePath
          : `/${inline.filePath}`,
        ...(side === "right"
          ? {
              rightFileStart: { line: startLine, offset: 1 },
              rightFileEnd: { line: endLine, offset: 80 },
            }
          : {
              leftFileStart: { line: startLine, offset: 1 },
              leftFileEnd: { line: endLine, offset: 80 },
            }),
      }
    : undefined;

  const payload: Record<string, unknown> = {
    comments: [{ content: text, commentType: 1 }],
    status: 1,
  };

  if (threadContext) {
    payload.threadContext = threadContext;
  }

  await adoRequest(url, pat, "POST", payload);
}

/**
 * Cast a reviewer vote on a PR.
 *
 * @param vote "approve" | "approve-with-suggestions" | "wait-for-author" | "reject"
 */
export async function castPrVote(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  pat: string,
  reviewerId: string,
  vote: string
): Promise<void> {
  const voteValue = VOTE_MAP[vote];
  if (voteValue === undefined) {
    throw new Error(`Unknown vote value: ${vote}`);
  }

  const url =
    `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests/${prId}/reviewers/${encodeURIComponent(reviewerId)}?api-version=7.1`;

  await adoRequest(url, pat, "PUT", { vote: voteValue });
}

/**
 * Fetch a structured diff for a PR.
 *
 * Returns one FileDiff per changed file with line-numbered hunks so the
 * reviewer agent can reliably anchor inline comments.
 */
export async function getPrDiff(
  orgUrl: string,
  project: string,
  repo: string,
  prId: number,
  pat: string
): Promise<FileDiff[]> {
  // Resolve the latest iteration ID first
  const iterUrl =
    `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests/${prId}/iterations?api-version=7.1`;

  const iterData = (await adoRequest(iterUrl, pat, "GET")) as {
    value: Array<{ id: number }>;
  };

  const iterations = iterData?.value ?? [];
  if (iterations.length === 0) return [];

  const latestIterId = iterations[iterations.length - 1].id;

  // Fetch all changed files in the latest iteration
  const changesUrl =
    `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests/${prId}/iterations/${latestIterId}/changes?api-version=7.1`;

  const changesData = (await adoRequest(changesUrl, pat, "GET")) as {
    changeEntries?: Array<{
      changeType: number; // 1=add, 2=edit, 4=delete, etc.
      item?: { path?: string; objectId?: string };
      originalItem?: { path?: string; objectId?: string };
    }>;
  };

  const changeEntries = changesData?.changeEntries ?? [];
  const results: FileDiff[] = [];

  for (const entry of changeEntries) {
    const path =
      entry.item?.path || entry.originalItem?.path || "";
    if (!path) continue;

    // changeType flags: 1=add, 2=edit, 4=delete, others=rename/copy
    // ADO uses a bitmask; masking to the lower 3 bits isolates the primary operation.
    const rawType = entry.changeType & 7; // 0b111 — lower 3 bits encode add/edit/delete
    let changeType: "add" | "modify" | "delete";
    if (rawType === 1) changeType = "add";
    else if (rawType === 4) changeType = "delete";
    else changeType = "modify";

    // Fetch file content diff using the diffs endpoint
    const diffUrl =
      `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
      `${encodeURIComponent(repo)}/diffs/commits?api-version=7.1` +
      `&baseVersionType=commit&baseVersion=${encodeURIComponent(entry.originalItem?.objectId ?? "")}` +
      `&targetVersionType=commit&targetVersion=${encodeURIComponent(entry.item?.objectId ?? "")}`;

    // Fetch the raw text of the new (right) file to build line-numbered hunks.
    // ADO's /diffs endpoint returns unified diff blocks as an array of blocks.
    // For simplicity and reliability we fetch the file content directly and
    // produce a single "full-file" hunk that the LLM can reference by line number.
    try {
      if (entry.item?.objectId && entry.item.objectId !== "0000000000000000000000000000000000000000") {
        const blobUrl =
          `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
          `${encodeURIComponent(repo)}/blobs/${encodeURIComponent(entry.item.objectId)}?api-version=7.1&$format=text`;

        const token = btoa(`:${pat}`);
        const blobRes = await fetch(blobUrl, {
          headers: { Authorization: `Basic ${token}`, Accept: "text/plain" },
        });

        if (blobRes.ok) {
          const text = await blobRes.text();
          const rawLines = text.split("\n");
          const lines: DiffLine[] = rawLines.map((content, idx) => ({
            lineNumber: idx + 1,
            content,
            type: changeType === "add" ? "add" : "context",
          }));

          results.push({
            path,
            changeType,
            hunks: [{ newStart: 1, lines }],
          });
          continue;
        }
      }
    } catch {
      // Fall through to stub entry
    }

    // Deleted file or fetch failed — add a stub entry with no lines
    results.push({ path, changeType, hunks: [] });
  }

  return results;
}

// ---------------------------------------------------------------------------
// PR listing
// ---------------------------------------------------------------------------

/** Minimal info about an open pull request, as returned by listOpenPrs. */
export interface PrSummary {
  id: number;
  title: string;
  createdBy: string;
  sourceRefName: string;
  targetRefName: string;
  status: string;
}

/**
 * List all active (open) pull requests in a repository.
 */
export async function listOpenPrs(
  orgUrl: string,
  project: string,
  repo: string,
  pat: string
): Promise<PrSummary[]> {
  const url =
    `${orgUrl.replace(/\/$/, "")}/${encodeURIComponent(project)}/_apis/git/repositories/` +
    `${encodeURIComponent(repo)}/pullRequests?searchCriteria.status=active&api-version=7.1`;

  const data = (await adoRequest(url, pat, "GET")) as {
    value?: Array<{
      pullRequestId: number;
      title: string;
      createdBy?: { displayName?: string };
      sourceRefName: string;
      targetRefName: string;
      status: string;
    }>;
  };

  return (data?.value ?? []).map((pr) => ({
    id: pr.pullRequestId,
    title: pr.title,
    createdBy: pr.createdBy?.displayName ?? "unknown",
    sourceRefName: pr.sourceRefName,
    targetRefName: pr.targetRefName,
    status: pr.status,
  }));
}

