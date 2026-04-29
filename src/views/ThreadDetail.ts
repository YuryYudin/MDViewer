import type { Ipc, Thread } from '../ipc';

/**
 * Mount the thread-detail view (wireframe 06). Renders the existing comments
 * (author + body via `textContent`) and a reply composer with Post + Resolve
 * buttons. The `tabId` flows in via a callback the parent passes — the same
 * pattern SelectionPopover uses — so the detail view never has to reach back
 * up the DOM to discover its tab.
 */
export function mountThreadDetail(
  root: HTMLElement,
  ipc: Ipc,
  thread: Thread,
  getTabId: () => string,
): void {
  root.replaceChildren();
  root.setAttribute('data-view', 'thread-detail');
  root.dataset.threadId = thread.id;

  const list = document.createElement('div');
  list.setAttribute('data-test', 'thread-comments');
  for (const c of thread.comments) {
    const item = document.createElement('article');
    item.setAttribute('data-test', 'thread-comment');
    item.dataset.commentId = c.id;

    const header = document.createElement('header');
    const author = document.createElement('span');
    author.className = 'author';
    author.textContent = c.author;
    header.appendChild(author);
    const ts = document.createElement('time');
    ts.dateTime = c.created_at;
    ts.textContent = c.created_at;
    header.appendChild(ts);
    item.appendChild(header);

    const body = document.createElement('p');
    body.setAttribute('data-test', 'comment-body-rendered');
    body.textContent = c.body;
    item.appendChild(body);

    list.appendChild(item);
  }
  root.appendChild(list);

  // Reply composer: textarea + Post + Resolve. Build via createElement so
  // user input stays in textContent on render and the no-innerHTML rule
  // holds.
  const composer = document.createElement('div');
  composer.className = 'composer';
  const ta = document.createElement('textarea');
  ta.setAttribute('data-test', 'reply-body');
  ta.placeholder = 'Reply…';
  composer.appendChild(ta);

  const post = document.createElement('button');
  post.setAttribute('data-action', 'post-reply');
  post.textContent = 'Post';
  post.addEventListener('click', async () => {
    const body = ta.value;
    await ipc.postReply(getTabId(), thread.id, body);
    ta.value = '';
    // Notify the parent so it can re-fetch threads and re-render. Without
    // this the new reply lives in the backend but isn't visible in the UI
    // until the user re-opens the doc.
    root.dispatchEvent(
      new CustomEvent('thread-replied', { bubbles: true, detail: { id: thread.id } }),
    );
  });
  composer.appendChild(post);

  const resolve = document.createElement('button');
  resolve.setAttribute('data-action', 'resolve');
  resolve.textContent = 'Resolve';
  resolve.addEventListener('click', async () => {
    await ipc.resolveThread(getTabId(), thread.id);
    root.dispatchEvent(
      new CustomEvent('thread-resolved', { bubbles: true, detail: { id: thread.id } }),
    );
  });
  composer.appendChild(resolve);

  root.appendChild(composer);
}
