import type { Ipc, Thread } from '../ipc';

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
 */
export function mountCommentsSidebar(
  root: HTMLElement,
  _ipc: Ipc,
  threads: Thread[],
  opts: { showResolved: boolean },
): void {
  root.replaceChildren();
  root.setAttribute('data-view', 'sidebar-comments');

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
