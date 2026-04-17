// ---------------------------------------------------------------------------
// Wiki index.md manager — parse, update, and search the page catalog
// ---------------------------------------------------------------------------

import { readIndexFile, writeIndexFile } from "./fs.js";

export interface IndexEntry {
  path: string;      // relative to wiki root, e.g. "pages/people/burke.md"
  title: string;
  summary: string;
  section: string;   // grouping header, e.g. "People", "Projects"
  tags?: string[];   // extracted from page frontmatter
  updated?: string;  // last updated date (YYYY-MM-DD)
}

/**
 * Parse index.md into structured entries.
 * Expected format (new):
 *   ## Section Name
 *   - [Title](path) — Summary text | tags: tag1, tag2 | updated: 2026-04-17
 * Also supports legacy format without tags/updated.
 */
export function parseIndex(): IndexEntry[] {
  const content = readIndexFile();
  const entries: IndexEntry[] = [];
  let currentSection = "Uncategorized";

  for (const line of content.split("\n")) {
    // Section headers
    const sectionMatch = line.match(/^##\s+(.+)/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].trim();
      continue;
    }

    // Entry lines: - [Title](path) — Summary | tags: t1, t2 | updated: YYYY-MM-DD
    const entryMatch = line.match(/^-\s+\[(.+?)\]\((.+?)\)\s*[—–-]\s*(.+)/);
    if (entryMatch) {
      const rawSummary = entryMatch[3].trim();
      // Parse optional | tags: ... | updated: ... suffixes
      let summary = rawSummary;
      let tags: string[] = [];
      let updated = "";

      const tagsMatch = rawSummary.match(/\|\s*tags:\s*([^|]+)/);
      if (tagsMatch) {
        tags = tagsMatch[1].split(",").map((t) => t.trim()).filter(Boolean);
        summary = summary.replace(tagsMatch[0], "").trim();
      }
      const updatedMatch = rawSummary.match(/\|\s*updated:\s*(\S+)/);
      if (updatedMatch) {
        updated = updatedMatch[1].trim();
        summary = summary.replace(updatedMatch[0], "").trim();
      }
      // Clean trailing pipe if any
      summary = summary.replace(/\|?\s*$/, "").trim();

      entries.push({
        title: entryMatch[1].trim(),
        path: entryMatch[2].trim(),
        summary,
        section: currentSection,
        tags: tags.length > 0 ? tags : undefined,
        updated: updated || undefined,
      });
    }
  }

  return entries;
}

/** Regenerate index.md from a list of entries, grouped by section. */
export function writeIndex(entries: IndexEntry[]): void {
  const sections = new Map<string, IndexEntry[]>();
  for (const entry of entries) {
    const list = sections.get(entry.section) || [];
    list.push(entry);
    sections.set(entry.section, list);
  }

  const lines: string[] = [
    "# Wiki Index",
    "",
    "_Max's knowledge base. This file is maintained automatically._",
    "",
    `Last updated: ${new Date().toISOString().slice(0, 10)}`,
    "",
  ];

  for (const [section, items] of sections) {
    lines.push(`## ${section}`, "");
    for (const item of items) {
      let line = `- [${item.title}](${item.path}) — ${item.summary}`;
      if (item.tags?.length) line += ` | tags: ${item.tags.join(", ")}`;
      if (item.updated) line += ` | updated: ${item.updated}`;
      lines.push(line);
    }
    lines.push("");
  }

  if (sections.size === 0) {
    lines.push("## Pages", "", "_(No pages yet.)_", "");
  }

  writeIndexFile(lines.join("\n"));
}

/** Add or update an entry in the index. Upserts by path. */
export function addToIndex(entry: IndexEntry): void {
  const entries = parseIndex();
  const existing = entries.findIndex((e) => e.path === entry.path);
  if (existing >= 0) {
    entries[existing] = entry;
  } else {
    entries.push(entry);
  }
  writeIndex(entries);
}

/** Remove an entry from the index by path. */
export function removeFromIndex(path: string): boolean {
  const entries = parseIndex();
  const filtered = entries.filter((e) => e.path !== path);
  if (filtered.length === entries.length) return false;
  writeIndex(filtered);
  return true;
}

/**
 * Search the index for entries matching a query.
 * Matches against title, summary, section, path, and tags using keyword overlap.
 * Boosts recently updated pages as a tiebreaker.
 */
export function searchIndex(query: string, limit = 10): IndexEntry[] {
  const entries = parseIndex();
  if (entries.length === 0) return [];

  const queryWords = new Set(
    query.toLowerCase().split(/\s+/).filter((w) => w.length > 2)
  );

  if (queryWords.size === 0) {
    return entries.slice(0, limit);
  }

  const now = Date.now();
  const scored = entries.map((entry) => {
    const text = `${entry.title} ${entry.summary} ${entry.section} ${entry.path} ${(entry.tags || []).join(" ")}`.toLowerCase();
    const words = text.split(/\s+/);
    let hits = 0;
    for (const w of words) {
      for (const q of queryWords) {
        if (w.includes(q)) { hits++; break; }
      }
    }
    // Tag exact match gets a bonus
    for (const tag of entry.tags || []) {
      for (const q of queryWords) {
        if (tag.toLowerCase() === q) { hits += 2; }
      }
    }
    // Recency boost: pages updated in the last 7 days get a small boost
    let recencyBoost = 0;
    if (entry.updated) {
      const daysSince = (now - new Date(entry.updated).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSince < 7) recencyBoost = 0.5;
      else if (daysSince < 30) recencyBoost = 0.2;
    }
    return { entry, score: hits + recencyBoost };
  })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored.map((s) => s.entry);
}

/** Get a compact text summary of the index for injection into context. */
export function getIndexSummary(): string {
  const entries = parseIndex();
  if (entries.length === 0) return "";

  const sections = new Map<string, string[]>();
  for (const e of entries) {
    const list = sections.get(e.section) || [];
    let item = `${e.title}: ${e.summary}`;
    if (e.tags?.length) item += ` [${e.tags.join(", ")}]`;
    if (e.updated) item += ` (${e.updated})`;
    list.push(item);
    sections.set(e.section, list);
  }

  const parts: string[] = [];
  for (const [section, items] of sections) {
    parts.push(`**${section}**: ${items.join("; ")}`);
  }
  return parts.join("\n");
}
