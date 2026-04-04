// ---------------------------------------------------------------------------
// Wiki context retrieval — replaces getRelevantMemories for prompt injection
// ---------------------------------------------------------------------------

import { searchIndex, getIndexSummary } from "./index-manager.js";
import { readPage, ensureWikiStructure } from "./fs.js";

/**
 * Get relevant wiki context for a user query.
 * Searches the index, reads top matching pages, and returns a formatted context block.
 */
export function getRelevantWikiContext(query: string, maxPages = 3): string {
  ensureWikiStructure();

  // Strip channel tags for cleaner matching
  const cleanQuery = query.replace(/^\[via (?:telegram|tui)\]\s*/i, "").trim();

  const matches = searchIndex(cleanQuery, maxPages);
  if (matches.length === 0) return "";

  const sections: string[] = [];
  for (const match of matches) {
    const content = readPage(match.path);
    if (!content) continue;

    // Strip frontmatter for cleaner context
    const body = content.replace(/^---[\s\S]*?---\s*/, "").trim();
    // Cap each page at 600 chars to avoid prompt bloat
    const trimmed = body.length > 600 ? body.slice(0, 600) + "…" : body;
    sections.push(`### ${match.title}\n${trimmed}`);
  }

  if (sections.length === 0) return "";
  return sections.join("\n\n");
}

/**
 * Get a summary of the wiki for the system message.
 * Returns the index summary (compact list of all pages).
 */
export function getWikiSummary(): string {
  ensureWikiStructure();
  return getIndexSummary();
}
