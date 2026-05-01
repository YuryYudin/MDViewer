import { describe, it, expect } from 'vitest';
import { initials } from '../../src/views/collabInitials';

/**
 * Tests for the shared `initials` helper that powers both CollabChip's
 * sidebar-header avatars and CommentsSidebar's per-thread author avatars.
 * The helper unifies what used to be two near-identical local implementations
 * (CollabChip.initials and CommentsSidebar.authorInitials). Behaviour
 * preserved by these tests:
 *   * Up-to-two letters from the displayName, uppercased.
 *   * Whitespace-trim + collapse-runs split.
 *   * Email first-char fallback when displayName is empty.
 *   * Final '?' fallback when both are empty.
 *   * Tolerates a missing emailAddress (the CommentsSidebar caller may not
 *     have one to pass when the comment author isn't in the collaborator
 *     list — the fallback chain still terminates at '?').
 */
describe('initials helper', () => {
  it('returns up to two upper-case letters from a two-word display name', () => {
    expect(initials('Alice Anderson', 'alice@example.com')).toBe('AA');
  });

  it('returns a single upper-case letter from a one-word display name', () => {
    expect(initials('Madonna', 'm@example.com')).toBe('M');
  });

  it('caps at the first two words when the display name is longer', () => {
    expect(initials('Mary Jane Watson Parker', 'mjw@example.com')).toBe('MJ');
  });

  it('collapses runs of whitespace before splitting', () => {
    expect(initials('  Alice    Anderson ', 'a@example.com')).toBe('AA');
  });

  it('falls back to the email first-character (uppercased) when displayName is empty', () => {
    expect(initials('', 'zoe@example.com')).toBe('Z');
  });

  it('falls back to the email first-character when displayName is whitespace-only', () => {
    expect(initials('   ', 'zoe@example.com')).toBe('Z');
  });

  it('returns "?" when both display name and email are empty', () => {
    expect(initials('', '')).toBe('?');
  });

  it('returns "?" when display name is empty and email is undefined', () => {
    // CommentsSidebar's authorInitials() callsite may not have an email to
    // pass when the comment's author isn't in the collaborator list.
    expect(initials('', undefined)).toBe('?');
  });

  it('returns "?" when display name is whitespace and email is undefined', () => {
    expect(initials('  ', undefined)).toBe('?');
  });

  it('returns the displayName initials even when email is undefined', () => {
    expect(initials('Alice Anderson', undefined)).toBe('AA');
  });
});
