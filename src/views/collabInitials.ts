/**
 * Compute up-to-two-character initials from a Drive display name. Trims
 * whitespace, splits on runs of whitespace, takes the first character of
 * the first two parts, uppercases. Falls back to the email's first char
 * when the display name is empty (some Drive accounts haven't set one);
 * a final `?` fallback covers the (vanishingly rare) case where both are
 * empty so we never emit a literal empty avatar.
 *
 * Shared by CollabChip (sidebar header avatars) and CommentsSidebar
 * (per-thread author avatars). The `emailAddress` argument is optional
 * so the CommentsSidebar callsite can pass `undefined` when the comment
 * author has no matching collaborator record — the fallback chain still
 * terminates at `?`.
 */
export function initials(displayName: string, emailAddress?: string): string {
  const parts = displayName.trim().split(/\s+/).filter(Boolean).slice(0, 2);
  const fromName = parts.map((p) => p[0]?.toUpperCase() ?? '').join('');
  if (fromName) return fromName;
  const fromEmail = emailAddress?.trim()[0]?.toUpperCase();
  if (fromEmail) return fromEmail;
  return '?';
}
