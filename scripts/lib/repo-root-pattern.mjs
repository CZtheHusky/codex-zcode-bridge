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
import { pathToFileURL } from "node:url";

export function buildRepoRootLeakPattern(root) {
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
  const httpUrlToken = String.raw`(?<!https?://[^\s"'\u0060]*)`;
  return new RegExp(
    `${httpUrlToken}(?<!${startContext})${escapedRoot}(?!${terminator})|(?<!${startContext})(?:${encodedRoot})(?!${terminator})`,
    "iu",
  );
}
