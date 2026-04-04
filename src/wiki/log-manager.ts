// ---------------------------------------------------------------------------
// Wiki log.md manager — append-only chronological operation log
// ---------------------------------------------------------------------------

import { appendFileSync } from "fs";
import { join } from "path";
import { WIKI_DIR } from "../paths.js";
import { ensureWikiStructure } from "./fs.js";

export type LogType = "ingest" | "update" | "lint" | "query" | "migrate" | "delete";

const LOG_PATH = join(WIKI_DIR, "log.md");

/**
 * Append a timestamped entry to log.md.
 * Format: `## [YYYY-MM-DD HH:MM] type | description`
 */
export function appendLog(type: LogType, description: string): void {
  ensureWikiStructure();
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace("T", " ");
  const entry = `## [${ts}] ${type} | ${description}\n\n`;
  appendFileSync(LOG_PATH, entry, "utf-8");
}
