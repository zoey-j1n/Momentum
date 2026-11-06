// Decision #10 addendum, Zoey 2026-11-06: every action item must point at the words in the thread that
// state it, and we check that quote exists before the item exists. An item the model cannot ground is an
// inference ("they picked Thursday to avoid SSO, so merging SSO must be a task") and is dropped, not shown.
// Pure: strings in, strings out. The quote is not stored; Analysis.rawOutput keeps the model's full answer.

/** Lowercase, strip punctuation, collapse whitespace: so "Rotate the password." matches "rotate the password". */
export function normalizeForMatch(s: string): string {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").replace(/\s+/g, " ").trim();
}

export type Verified<T> = { kept: T[]; dropped: T[] };

/** Keep items whose evidence quote appears in the transcript (normalized); drop the rest. Empty evidence is dropped. */
export function verifyEvidence<T extends { evidence: string }>(items: T[], transcript: string): Verified<T> {
  const haystack = normalizeForMatch(transcript);
  const kept: T[] = [], dropped: T[] = [];
  for (const item of items) {
    const needle = normalizeForMatch(item.evidence);
    (needle.length >= 3 && haystack.includes(needle) ? kept : dropped).push(item);
  }
  return { kept, dropped };
}
