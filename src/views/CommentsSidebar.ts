import type { Ipc, Thread } from '../ipc';
import { mountOrphanComments } from './OrphanComments';

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
  _ipc: Ipc,
  threads: Thread[],
  opts: {
    showResolved: boolean;
    orphans?: Thread[];
    onRelocateOrphan?(id: string): void;
    onKeepOrphan?(id: string): void;
    onDeleteOrphan?(id: string): void;
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

    const header = document.createElement('header');
    header.setAttribute('data-test', 'thread-author');
    header.textContent = t.comments[0]?.author ?? '';
    article.appendChild(header);

    const body = document.createElement('p');
    body.setAttribute('data-test', 'comment-body-rendered');
    body.textContent = t.comments[0]?.body ?? '';
    article.appendChild(body);

    article.addEventListener('click', () => {
      article.dispatchEvent(
        new CustomEvent('thread-activate', { bubbles: true, detail: { id: t.id } }),
      );
    });
    root.appendChild(article);
  }
}
