// Builds the pattern validate-plugin.mjs uses to detect whether a bundle
// embeds the development repository's absolute path. Kept in scripts/lib so
// the boundary semantics can be regression-tested directly.
//
// A genuine path reference is delimited by path/string structure, not by a
// blacklist of "name characters":
// - On the right, the root may only be followed by a path separator, a
//   string/line terminator, or the end of the input. Anything else — a space,
//   `%20`, `@`, `+`, `(`, a letter, a dot — continues a longer path segment
//   ("/app Backup", "/app@2", "/app.git" are sibling names, not this root).
// - On the left, the root must start in a context where an absolute path can
//   begin: start of input, whitespace (a comment like "// /app/src"), a
//   quote, or a token separator like `=`, `:`, `(`, `,`, `;`, `/`, `\`.
//   A name character or a URL authority tail ("example.test/app",
//   "[::1]/app") means the hit is the middle of a longer name or an ordinary
//   HTTP URL path, not a local absolute path. Deeper URL path segments are
//   covered by the scheme lookbehind on the raw branch: any http(s) URL
//   opened earlier in the same token (no whitespace/quote/backtick in
//   between) suppresses the raw match.
// Each raw separator position matches one or two separators (`/` or `\`):
// bundles embed Windows absolute paths both raw (C:\repo\src) and
// JS-string-escaped (C:\\repo\\src with literal doubled backslashes), and
// both spellings name the same development path.
//
// The second alternative is the root's complete standard file URI
// (pathToFileURL, scheme included): spaces and non-ASCII segments are
// percent-encoded there, so the raw pattern cannot see them. It is NOT
// subject to the http(s) suppression — a file: URI embedded inside an HTTP
// URL (a redirect target) is still a reference to the local development
// path. The delimiters still apply: "file:///app%20Backup/src" extends the
// segment and must not match, while "file:///app/src" must. Scheme-less
// percent-encoded spellings are not covered by this check.
//
// Filesystem roots are rejected up front (2026-10-17): a POSIX root would
// match every "//" line comment and every file URI in the bundle, a drive or
// share root every same-volume absolute path — the check could only produce
// guaranteed false positives, never a meaningful verdict. Rejecting loudly
// keeps validate-plugin from silently degrading into a no-op.
import path from "node:path";
import { pathToFileURL } from "node:url";

const POSIX_ROOT = /^\/+$/u;
const DRIVE_ROOT = /^[a-zA-Z]:[\\/]?$/u;
const EXTENDED_DRIVE_ROOT = /^\\\\[.?]\\[a-zA-Z]:[\\/]?$/u;
const UNC_SHARE_ROOT = /^\\\\(?:\?\\UNC\\)?[^\\/]+[\\/][^\\/]+[\\/]?$/u;

/** Root predicates are separator-agnostic: a root consists only of the
 * volume designator plus separators, so testing the backslash-mapped spelling
 * with the slash-based patterns covers both spellings at once. */
const asRootLike = (value) => value.replace(/\\/gu, "/");

const isPosixRoot = (value) => POSIX_ROOT.test(asRootLike(value));
const isDriveRoot = (value) => DRIVE_ROOT.test(asRootLike(value));
const isExtendedDriveRoot = (value) => EXTENDED_DRIVE_ROOT.test(value);
const isUncShareRoot = (value) => UNC_SHARE_ROOT.test(value);
const isFilesystemRootSpelling = (value) =>
  isPosixRoot(value) || isDriveRoot(value) || isExtendedDriveRoot(value) || isUncShareRoot(value);

/** Throws an explanatory error when `root` names an entire filesystem,
 * volume, or share instead of a repository checkout. Public so callers and
 * tests can share the exact rejection semantics.
 *
 * Lexically equivalent spellings count (2026-10-17 review): "/./", "/alpha/.."
 * and "C:/alpha/.." normalize to roots, and a pattern built from them would
 * degenerate exactly like the bare root (the file-URI alternative especially).
 * The guard therefore runs BOTH platform normalizers on every input and tests
 * every candidate with separator-agnostic root predicates; the ORIGINAL
 * string is still what gets embedded in the message. Consequences verified
 * by tests: a named extended-length checkout ("\\?\C:\repo") survives because
 * its normalized candidates are not roots, while win32.normalize DOES
 * collapse ".." after an extended prefix ("\\?\C:\repo\.." becomes "\\?\C:",
 * a drive root) — such a spelling is rejected as the root it collapses to. */
export function assertNotFilesystemRoot(root) {
  if (typeof root !== "string" || root.trim() === "") {
    throw new Error(
      "buildRepoRootLeakPattern requires a non-empty repository root string; refusing to build a meaningless leak pattern",
    );
  }
  const normalizedCandidates = new Set([root]);
  for (const normalize of [path.win32.normalize, path.posix.normalize]) {
    try { normalizedCandidates.add(normalize(root)); } catch { /* platform-specific parse failures keep the original */ }
  }
  const rootCandidate = [...normalizedCandidates].find(isFilesystemRootSpelling);
  if (!rootCandidate) return;
  const extendedDrive = /^\\\\[.?]\\([a-zA-Z]):/u.exec(rootCandidate);
  const kind = isPosixRoot(rootCandidate) ? "a POSIX filesystem root"
    : isDriveRoot(rootCandidate) ? `the root of drive ${asRootLike(rootCandidate).slice(0, 2)}`
      : extendedDrive ? `the root of drive ${extendedDrive[1]}: (extended-length spelling)`
        : "the root of a UNC share";
  const normalizedNote = rootCandidate === root ? "" : ` (lexically equivalent to ${JSON.stringify(rootCandidate)})`;
  throw new Error(
    `buildRepoRootLeakPattern refuses the filesystem root ${JSON.stringify(root)}${normalizedNote} (${kind}): `
    + "every absolute path under it would match, so the leak check could only report false positives "
    + '(a POSIX root even flags ordinary "//" comments), never a usable verdict. '
    + "Run validation from a checkout located under a named directory.",
  );
}

export function buildRepoRootLeakPattern(root) {
  assertNotFilesystemRoot(root);
  const escapedRoot = root
    .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
    .replace(/\\\\/gu, "[/\\\\]{1,2}");
  // pathToFileURL is platform-dependent for drive-less roots (Windows
  // prepends the current drive), so a POSIX-style root also contributes its
  // cross-platform spelling; hosts and tests agree regardless of platform.
  const encodedCandidates = new Set([pathToFileURL(root).href]);
  if (root.startsWith("/")) encodedCandidates.add(pathToFileURL(root, { windows: false }).href);
  const encodedRoot = [...encodedCandidates]
    .map((candidate) => candidate.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  // Complement classes: "previous char (if any) must be an allowed start
  // context" and "next char (if any) must be an allowed terminator". The
  // backtick is expressed as \u0060 so it can live inside these templates.
  const startContext = String.raw`[^\s"'=(:,;\\/\u0060]`;
  const terminator = String.raw`[^/\\'"\n\r\t\u0060]`;
  // The URL suppression covers both an earlier complete scheme ("https://"
  // plus any run of URL characters) and the position right behind the scheme
  // colon and its first slash, where the authority begins: a URL whose host
  // is exactly the root name ("https://app/config" for root /app) is an
  // ordinary URL, not a local absolute path. A file: URI is never suppressed
  // (separate alternative below).
  const httpUrlToken = String.raw`(?<!https?:\/?)(?<!https?://[^\s"'\u0060]*)`;
  return new RegExp(
    `${httpUrlToken}(?<!${startContext})${escapedRoot}(?!${terminator})|(?<!${startContext})(?:${encodedRoot})(?!${terminator})`,
    "iu",
  );
}
