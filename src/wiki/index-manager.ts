// ---------------------------------------------------------------------------
// Wiki index.md manager — parse, update, and search the page catalog
// ---------------------------------------------------------------------------

import { readIndexFile, writeIndexFile } from "./fs.js";

export interface IndexEntry {
  path: string;      // relative to wiki root, e.g. "pages/people/burke.md"
  title: string;
  summary: string;
  section: string;   // grouping header, e.g. "People", "Projects"
}

/**
 * Parse index.md into structured entries.
 * Expected format:
 *   ## Section Name
 *   - [Title](path) — Summary text
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

    // Entry lines: - [Title](path) — Summary
    const entryMatch = line.match(/^-\s+\[(.+?)\]\((.+?)\)\s*[—–-]\s*(.+)/);
    if (entryMatch) {
      entries.push({
        title: entryMatch[1].trim(),
        path: entryMatch[2].trim(),
        summary: entryMatch[3].trim(),
        section: currentSection,
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
      lines.push(`- [${item.title}](${item.path}) — ${item.summary}`);
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
 * Matches against title, summary, section, and path using keyword overlap.
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

  const scored = entries.map((entry) => {
    const text = `${entry.title} ${entry.summary} ${entry.section} ${entry.path}`.toLowerCase();
    const words = text.split(/\s+/);
    let hits = 0;
    for (const w of words) {
      for (const q of queryWords) {
        if (w.includes(q)) { hits++; break; }
      }
    }
    return { entry, hits };
  })
    .filter((s) => s.hits > 0)
    .sort((a, b) => b.hits - a.hits)
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
    list.push(`${e.title}: ${e.summary}`);
    sections.set(e.section, list);
  }

  const parts: string[] = [];
  for (const [section, items] of sections) {
    parts.push(`**${section}**: ${items.join("; ")}`);
  }
  return parts.join("\n");
}
