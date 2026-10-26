/** Normalisation applied to both indexed text and queries (Arabic-friendly). */
export function normalizeForSearch(text: string): string {
  return text
    .normalize("NFKC")
    .replace(/[\u064B-\u065F\u0670\u06D6-\u06ED]/g, "") // tashkeel / Quranic marks
    .replace(/\u0640/g, "") // tatweel
    .replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627") // alef variants -> ا
    .replace(/\u0649/g, "\u064A") // ى -> ي
    .replace(/\u0629/g, "\u0647"); // ة -> ه
}

/** Build a safe FTS5 MATCH expression: every token must match (prefix). Returns null if no tokens. */
export function buildFtsQuery(q: string): string | null {
  const tokens = normalizeForSearch(q)
    .split(/[^\p{L}\p{N}_]+/u)
    .filter(Boolean)
    .slice(0, 12);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `"${t.replace(/"/g, '""')}"*`).join(" ");
}

export const SNIPPET_OPEN = "[[";
export const SNIPPET_CLOSE = "]]";
