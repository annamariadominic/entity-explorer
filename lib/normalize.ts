/**
 * The single implementation of the dedup normalization rules. The Postgres
 * resolution function takes normalized values as arguments rather than
 * computing them, so these rules never exist in two places.
 */

const LEGAL_SUFFIXES = [
  "incorporated", "inc", "llc", "l l c", "ltd", "limited", "corp", "corporation",
  "co", "company", "plc", "gmbh", "ag", "sa", "nv", "bv", "ab", "oy", "as",
  "pty", "llp", "lp", "holdings", "group",
];

export function normalizeName(raw: string): string {
  let s = raw.normalize("NFKD").toLowerCase();

  // Strip diacritics so "Spotify AB" and "Spotifý" collapse the same way.
  s = s.replace(/[̀-ͯ]/g, "");
  // Possessives would otherwise leave a dangling "s" token.
  s = s.replace(/['\u2019]s\b/g, "");
  s = s.replace(/&/g, " and ");
  s = s.replace(/[.,'"“”’`()\[\]|/\\!?:;*_-]/g, " ");
  s = s.replace(/\s+/g, " ").trim();

  if (s.startsWith("the ")) s = s.slice(4);

  // Punctuation removal turns "S.A." into "s a", which would no longer match
  // the legal-suffix list. Rejoin runs of single letters ("nestle s a" ->
  // "nestle sa") before suffix stripping.
  s = s
    .split(" ")
    .reduce<string[]>((tokens, token) => {
      const last = tokens[tokens.length - 1];
      if (token.length === 1 && last?.length === 1) {
        tokens[tokens.length - 1] = last + token;
      } else {
        tokens.push(token);
      }
      return tokens;
    }, [])
    .join(" ");

  // Legal suffixes can stack ("Foo Group Holdings Ltd"), so strip repeatedly.
  let stripped = true;
  while (stripped) {
    stripped = false;
    for (const suffix of LEGAL_SUFFIXES) {
      if (s.endsWith(" " + suffix)) {
        s = s.slice(0, -(suffix.length + 1)).trim();
        stripped = true;
        break;
      }
    }
  }

  return s.replace(/\s+/g, " ").trim();
}

/**
 * Identifier matching only fires if the URLs collapse to the same string, so
 * this has to be aggressive: scheme, www, trailing slash, query and fragment
 * all go. Returns null for anything unparseable rather than storing junk that
 * could false-match.
 */
export function normalizeUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
    const url = new URL(withScheme);
    const host = url.hostname.toLowerCase().replace(/^www\./, "");
    const path = url.pathname.replace(/\/+$/, "");
    if (!host.includes(".")) return null;
    return host + path;
  } catch {
    return null;
  }
}
