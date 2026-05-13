import type { Ipc, Thread } from '../ipc';
import type { DriveCollaborator, TabBackend } from '../types-generated';
import { initials } from './collabInitials';
import { mountOrphanComments } from './OrphanComments';
import { mountThreadDetail } from './ThreadDetail';

/**
 * Look up the comment author's collaborator record by email, then return
 * up-to-two-character initials via the shared `initials()` helper so the
 * avatars in the sidebar header and the per-thread header use the same
 * formatting. Returns `?` when the author isn't in the collaborator list
 * (the comment was authored before the user gained access, or the file's
 * permissions changed since the polling cache was last refreshed).
 */
function authorInitials(email: string, collaborators: DriveCollaborator[]): string {
  const match = collaborators.find((c) => c.email_address === email);
  if (!match) return '?';
  return initials(match.display_name, match.email_address);
}

/**
 * Mount the comments sidebar (wireframe 05). User-supplied author names and
 * comment bodies go through `textContent` so HTML-looking characters are
 * displayed verbatim, not parsed. The `showResolved` toggle hides resolved
 * threads when off; turning it on keeps them in the list with a `.resolved`
 * class so the wireframe's "muted" styling can apply.
 *
 * Clicking a thread row dispatches a `thread-activate` CustomEvent (bubbling)
 * carrying the thread id. The Workspace shell (A9 / A10 wiring) listens at
 * the body region to route activation into a ThreadDetail mount.
 *
 * `opts.orphans`, when non-empty, mounts OrphanComments above the regular
 * thread list so wireframe 09's Relocate / Keep / Delete actions surface in
 * the same sidebar pane. The orphan list is computed by Document.ts after a
 * View↔Edit round-trip (see B4 wire-up).
 */
export function mountCommentsSidebar(
  root: HTMLElement,
  ipc: Ipc,
  threads: Thread[],
  opts: {
    showResolved: boolean;
    orphans?: Thread[];
    onRelocateOrphan?(id: string): void;
    onKeepOrphan?(id: string): void;
    onDeleteOrphan?(id: string): void;
    /** When set, the inline ThreadDetail mount uses this for postReply /
     *  resolveThread IPC calls. Without it, ThreadDetail isn't rendered
     *  (the test-mode call sites for CommentsSidebar in unit tests don't
     *  always supply a tabId). */
    activeTabId?: string;
    /** B6: backend for the active tab. When set to a Drive backend, threads
     *  whose comments include any null `drive_id` render a "Pending" pill
     *  next to the header. Local-backend tabs never render the pill (they
     *  don't round-trip through Drive). */
    backend?: TabBackend;
    /** C1: collaborator list for the active Drive-backed tab. When supplied
     *  alongside a Drive backend, each thread renders an initials author
     *  avatar (`.author-avatar`) sourced from the matching collaborator
     *  record. Local-backend tabs ignore this prop (no Drive identity
     *  layer) and an empty list also suppresses the avatar so we don't
     *  paint a wall of `?`s while the loader is in flight. */
    collaborators?: DriveCollaborator[];
  },
): void {
  root.replaceChildren();
  // The outer `data-region="sidebar"` element (created by Workspace.ts) owns
  // the 320 px column layout and `overflow: hidden`. The inner scroll host
  // takes `[data-view='sidebar-comments']` so its `overflow: auto` rule wins
  // — when this used to live on `root` directly, the outer `overflow: hidden`
  // selector beat it on specificity and the sidebar silently clipped instead
  // of scrolling once content exceeded the viewport.
  const scrollHost = document.createElement('div');
  scrollHost.setAttribute('data-view', 'sidebar-comments');
  root.appendChild(scrollHost);

  // Header row with a close (×) button. Clicking dispatches the same
  // `mdviewer:toggle-sidebar` event the View menu / Cmd+Shift+S keymap
  // fires, so all three input surfaces converge on the Workspace listener.
  // The `data-test="sidebar-close"` selector is what the unit + e2e specs
  // assert on.
  const header = document.createElement('div');
  header.setAttribute('data-region', 'sidebar-header');
  const title = document.createElement('span');
  title.className = 'sidebar-title';
  title.textContent = 'Comments';
  // Manual reload button (2025-05-01): force a re-read of the sidecar
  // file from disk. Useful when Drive Desktop has just synced down a
  // collaborator's edit but the watcher hasn't picked up the change yet
  // (rare on macOS, more common on network filesystems). The watcher
  // already auto-reloads sidecar changes when it sees them — this button
  // is a "kick it now" escape hatch.
  const reloadBtn = document.createElement('button');
  reloadBtn.setAttribute('data-test', 'sidebar-reload');
  reloadBtn.setAttribute('data-action', 'reload-comments');
  reloadBtn.setAttribute('title', 'Reload comments from disk');
  reloadBtn.setAttribute('aria-label', 'Reload comments from disk');
  reloadBtn.textContent = '↻';
  reloadBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:reload-comments'));
  });
  const closeBtn = document.createElement('button');
  closeBtn.setAttribute('data-test', 'sidebar-close');
  closeBtn.setAttribute('data-action', 'close-sidebar');
  closeBtn.setAttribute('title', 'Hide comments sidebar');
  closeBtn.setAttribute('aria-label', 'Hide comments sidebar');
  closeBtn.textContent = '×';
  closeBtn.addEventListener('click', () => {
    document.dispatchEvent(new CustomEvent('mdviewer:toggle-sidebar'));
  });
  header.append(title, reloadBtn, closeBtn);
  scrollHost.appendChild(header);

  // Orphan section sits at the top so it's visible without scrolling, which
  // is the wireframe-09 layout. Suppressed entirely when the list is empty.
  if (opts.orphans && opts.orphans.length > 0) {
    const orphanRegion = document.createElement('div');
    orphanRegion.setAttribute('data-region', 'orphans');
    mountOrphanComments(orphanRegion, {
      orphans: opts.orphans.map((t) => ({
        id: t.id,
        anchor: { exact: t.anchor.exact },
        comments: t.comments.map((c) => ({ author: c.author, body: c.body })),
      })),
      onRelocate: (id) => {
        opts.onRelocateOrphan?.(id);
        // Phase C will wire the actual relocate UX; the bubbling event lets
        // Workspace re-route into a relocate dialog without coupling the
        // sidebar to that view.
        scrollHost.dispatchEvent(
          new CustomEvent('mdviewer:relocate-orphan', { bubbles: true, detail: { id } }),
        );
      },
      onKeep: (id) => opts.onKeepOrphan?.(id),
      onDelete: (id) => {
        opts.onDeleteOrphan?.(id);
        scrollHost.dispatchEvent(
          new CustomEvent('mdviewer:delete-thread', { bubbles: true, detail: { id } }),
        );
      },
    });
    scrollHost.appendChild(orphanRegion);
  }

  // Count badges for spec/UI parity (wireframe-05): how many threads
  // landed anchored vs in the orphan list. Always rendered when there's
  // any thread activity so the count is reachable for the e2e suite even
  // when both buckets are zero (e.g. spec 05's reattach-success path).
  const anchoredCount = threads.filter((t) => !t.resolved).length;
  const orphanedCount = opts.orphans?.length ?? 0;
  if (threads.length > 0 || orphanedCount > 0) {
    const counts = document.createElement('div');
    counts.setAttribute('data-region', 'thread-counts');
    const anchored = document.createElement('span');
    anchored.setAttribute('data-test', 'anchored-count');
    anchored.textContent = String(anchoredCount);
    const orphaned = document.createElement('span');
    orphaned.setAttribute('data-test', 'orphaned-count');
    orphaned.textContent = String(orphanedCount);
    counts.append(anchored, orphaned);
    scrollHost.appendChild(counts);
  }

  const visible = threads.filter((t) => opts.showResolved || !t.resolved);
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.setAttribute('data-empty', 'true');
    empty.textContent = 'No comments yet';
    scrollHost.appendChild(empty);
    return;
  }

  for (const t of visible) {
    const article = document.createElement('article');
    article.className = `thread${t.resolved ? ' resolved' : ''}`;
    article.dataset.threadId = t.id;
    article.setAttribute('data-test', 'thread');

    article.addEventListener('click', () => {
      article.dispatchEvent(
        new CustomEvent('thread-activate', { bubbles: true, detail: { id: t.id } }),
      );
    });

    // B6: Pending pill — thread-level state. A thread is "Pending" when
    // any of its comments lacks a Drive id (e.g. authored offline, queue
    // not yet replayed). One pill per thread, not per comment, matches
    // wireframe-06's affordance and avoids visually doubling up on a
    // multi-reply thread that's all queued. Only emitted on Drive-backend
    // tabs — Local docs never round-trip to Drive so a "Pending" badge
    // there would be misleading. Inserted before the inner header/detail
    // so the pill is reachable via `.thread .pending-pill` regardless of
    // which sub-mount (summary vs ThreadDetail) follows.
    if (
      opts.backend &&
      opts.backend !== 'local' &&
      t.comments.some((c) => !c.drive_id)
    ) {
      const pill = document.createElement('span');
      pill.className = 'pending-pill';
      pill.setAttribute('data-test', 'pending-pill');
      pill.textContent = 'Pending';
      article.appendChild(pill);
    }

    // C1: thread-author avatar — initials chip sourced from the active
    // tab's collaborator list. Drive Comments only carry the author email
    // on the wire; the matching DriveCollaborator (if any) supplies the
    // display name we render. We render at most one avatar per thread,
    // pinned to the first comment's author so the visual affordance lines
    // up with the wireframe-05 "thread starter" cue. Suppressed entirely
    // on Local-backend tabs (no Drive identity layer) and when the loader
    // hasn't yet returned any collaborators (so we don't paint a wall of
    // `?`s while the chip is still in flight).
    if (
      opts.backend &&
      opts.backend !== 'local' &&
      opts.collaborators &&
      opts.collaborators.length > 0
    ) {
      const firstAuthor = t.comments[0]?.author_email;
      if (firstAuthor) {
        const avatar = document.createElement('span');
        avatar.className = 'author-avatar';
        avatar.textContent = authorInitials(firstAuthor, opts.collaborators);
        article.appendChild(avatar);
      }
    }

    // A3 (phase-a-finish): the W3C-style quoted text from the thread's
    // anchor lands as a `<div class="quote">` child of the row. The
    // comment-from-selection e2e spec asserts on `.quote.getText()` to
    // confirm the new thread quotes the exact selected phrase. The
    // orphan-list path at the top of this function already reads
    // `t.anchor.exact` (line ~122); the main thread render path needs
    // the same field. Skip the element entirely when `anchor.exact` is
    // empty so a synthetic / post-relocate thread with no anchored text
    // doesn't paint an empty italic strip. Inserted before the
    // header/body so it sits between the thread-level header chips
    // (pending pill, author avatar) and the first comment, matching
    // wireframe 08-selection-comment.html.
    if (t.anchor.exact && t.anchor.exact.length > 0) {
      const quote = document.createElement('div');
      quote.className = 'quote';
      quote.textContent = t.anchor.exact;
      article.appendChild(quote);
    }

    if (opts.activeTabId) {
      // Production mode: mount ThreadDetail inline. Detail already
      // shows every comment with author + body, so adding our own
      // summary header/body here would duplicate the first comment.
      // Skip the summary; the test selectors `[data-test="thread-author"]`
      // and `[data-test="comment-body-rendered"]` remain reachable
      // through the detail's own children.
      const detailRoot = document.createElement('div');
      detailRoot.className = 'thread-detail-mount';
      mountThreadDetail(detailRoot, ipc, t, () => opts.activeTabId!);
      article.appendChild(detailRoot);
    } else {
      // Test/preview mode: keep the flat summary shape unit tests assert on.
      const header = document.createElement('header');
      header.setAttribute('data-test', 'thread-author');
      header.textContent = t.comments[0]?.author ?? '';
      article.appendChild(header);

      const body = document.createElement('p');
      body.setAttribute('data-test', 'comment-body-rendered');
      body.textContent = t.comments[0]?.body ?? '';
      article.appendChild(body);
    }
    scrollHost.appendChild(article);
  }
}
