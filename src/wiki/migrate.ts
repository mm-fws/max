// ---------------------------------------------------------------------------
// One-time migration: SQLite memories → wiki pages
// ---------------------------------------------------------------------------

import { getDb, getState, setState } from "../store/db.js";
import { ensureWikiStructure, writePage, readPage } from "./fs.js";
import { addToIndex, type IndexEntry } from "./index-manager.js";
import { appendLog } from "./log-manager.js";

const MIGRATION_KEY = "wiki_migrated";

/** Check whether a migration is needed (wiki not yet populated from SQLite). */
export function shouldMigrate(): boolean {
  return getState(MIGRATION_KEY) !== "true";
}

/** Category → wiki page path and section name */
const CATEGORY_MAP: Record<string, { path: string; title: string; section: string }> = {
  preference: { path: "pages/preferences.md", title: "Preferences", section: "Knowledge" },
  fact:       { path: "pages/facts.md",       title: "Facts",       section: "Knowledge" },
  project:    { path: "pages/projects.md",    title: "Projects",    section: "Knowledge" },
  person:     { path: "pages/people.md",      title: "People",      section: "Knowledge" },
  routine:    { path: "pages/routines.md",     title: "Routines",    section: "Knowledge" },
};

/**
 * Migrate all existing SQLite memories into wiki pages.
 * Groups memories by category, creates one page per category.
 * Returns the number of memories migrated.
 */
export function migrateMemoriesToWiki(): number {
  ensureWikiStructure();

  const db = getDb();
  const rows = db.prepare(
    `SELECT id, category, content, source, created_at FROM memories ORDER BY category, id`
  ).all() as { id: number; category: string; content: string; source: string; created_at: string }[];

  if (rows.length === 0) {
    setState(MIGRATION_KEY, "true");
    appendLog("migrate", "No memories to migrate (empty table).");
    return 0;
  }

  // Group by category
  const grouped: Record<string, typeof rows> = {};
  for (const row of rows) {
    if (!grouped[row.category]) grouped[row.category] = [];
    grouped[row.category].push(row);
  }

  const now = new Date().toISOString().slice(0, 10);

  for (const [category, items] of Object.entries(grouped)) {
    const mapping = CATEGORY_MAP[category] || {
      path: `pages/${category}.md`,
      title: category.charAt(0).toUpperCase() + category.slice(1),
      section: "Knowledge",
    };

    // Build the page content
    const lines: string[] = [
      "---",
      `title: ${mapping.title}`,
      `tags: [${category}, migrated]`,
      `created: ${now}`,
      `updated: ${now}`,
      "---",
      "",
      `# ${mapping.title}`,
      "",
      `_Migrated from Max's memory store on ${now}._`,
      "",
    ];

    for (const item of items) {
      lines.push(`- ${item.content} _(${item.source}, ${item.created_at.slice(0, 10)})_`);
    }
    lines.push("");

    // Check if a page already exists (avoid clobbering manual content)
    const existing = readPage(mapping.path);
    if (existing) {
      // Extract only the bullet-point items to append
      const bulletLines = lines.filter((l) => l.startsWith("- "));
      writePage(mapping.path, existing + "\n## Migrated Memories\n\n" + bulletLines.join("\n") + "\n");
    } else {
      writePage(mapping.path, lines.join("\n"));
    }

    // Update index
    const entry: IndexEntry = {
      path: mapping.path,
      title: mapping.title,
      summary: `${items.length} ${category} memories (migrated from SQLite)`,
      section: mapping.section,
    };
    addToIndex(entry);
  }

  const total = rows.length;
  const categories = Object.keys(grouped).join(", ");
  appendLog("migrate", `Migrated ${total} memories across categories: ${categories}`);

  setState(MIGRATION_KEY, "true");
  console.log(`[max] Wiki migration complete: ${total} memories → ${Object.keys(grouped).length} pages`);

  return total;
}
