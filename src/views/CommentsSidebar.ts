import type { Ipc, Thread } from '../ipc';
import { mountOrphanComments } from './OrphanComments';
import { mountThreadDetail } from './ThreadDetail';

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
  },
): void {
  root.replaceChildren();
  root.setAttribute('data-view', 'sidebar-comments');

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
        root.dispatchEvent(
          new CustomEvent('mdviewer:relocate-orphan', { bubbles: true, detail: { id } }),
        );
      },
      onKeep: (id) => opts.onKeepOrphan?.(id),
      onDelete: (id) => {
        opts.onDeleteOrphan?.(id);
        root.dispatchEvent(
          new CustomEvent('mdviewer:delete-thread', { bubbles: true, detail: { id } }),
        );
      },
    });
    root.appendChild(orphanRegion);
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
    root.appendChild(counts);
  }

  const visible = threads.filter((t) => opts.showResolved || !t.resolved);
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.setAttribute('data-empty', 'true');
    empty.textContent = 'No comments yet';
    root.appendChild(empty);
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
    root.appendChild(article);
  }
}
