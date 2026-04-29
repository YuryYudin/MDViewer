/**
 * Wireframe 09: orphan-comments UX. When the user edits the document and the
 * saved bytes change enough that `resolve_anchor_with_threshold` falls below
 * `comments.reattachment_confidence`, the affected threads land here rather
 * than being silently deleted. The user picks Relocate / Keep / Delete per
 * thread — auto-deletion would discard their content without consent, which
 * is the failure mode the wireframe was designed to prevent.
 *
 * Author names and comment bodies go through `textContent`, never innerHTML,
 * so the original quote and body render verbatim regardless of HTML-looking
 * characters.
 */
export interface OrphanItem {
  id: string;
  anchor: { exact: string };
  comments: { author: string; body: string }[];
}

export interface OrphanCallbacks {
  orphans: OrphanItem[];
  onRelocate(id: string): void;
  onKeep(id: string): void;
  onDelete(id: string): void;
}

export function mountOrphanComments(root: HTMLElement, opts: OrphanCallbacks): void {
  root.replaceChildren();
  if (opts.orphans.length === 0) return;

  const wrap = document.createElement('section');
  wrap.setAttribute('data-view', 'orphan-comments');

  const heading = document.createElement('header');
  heading.setAttribute('data-test', 'orphan-heading');
  heading.textContent = 'Orphan comments';
  wrap.appendChild(heading);

  for (const o of opts.orphans) {
    const item = document.createElement('article');
    item.className = 'orphan';
    item.setAttribute('data-orphan-id', o.id);

    const quote = document.createElement('p');
    quote.className = 'quote';
    // U+201C / U+201D smart quotes around the original anchor text — purely
    // visual, the underlying string is still pure textContent.
    quote.textContent = `“${o.anchor.exact}”`;
    item.appendChild(quote);

    const first = o.comments[0];
    const author = document.createElement('p');
    author.className = 'author';
    author.textContent = first?.author ?? '';
    item.appendChild(author);

    const body = document.createElement('p');
    body.className = 'body';
    body.textContent = first?.body ?? '';
    item.appendChild(body);

    const actions = document.createElement('div');
    actions.className = 'actions';

    const relocate = document.createElement('button');
    relocate.setAttribute('data-action', 'relocate');
    relocate.textContent = 'Relocate';
    relocate.addEventListener('click', () => opts.onRelocate(o.id));
    actions.appendChild(relocate);

    const keep = document.createElement('button');
    keep.setAttribute('data-action', 'keep');
    keep.textContent = 'Keep';
    keep.addEventListener('click', () => {
      // Visually mark the card so the user can tell at-a-glance which
      // orphans they have already triaged. No IPC for v1 — the kept-state
      // is per-session UI hint only.
      item.classList.add('kept');
      opts.onKeep(o.id);
    });
    actions.appendChild(keep);

    const del = document.createElement('button');
    del.setAttribute('data-action', 'delete');
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      // Confirm before destruction — wireframe 09 specifies a confirm prompt
      // because there is no undo for thread deletion.
      if (window.confirm('Delete this orphan thread? This cannot be undone.')) {
        opts.onDelete(o.id);
      }
    });
    actions.appendChild(del);

    item.appendChild(actions);
    wrap.appendChild(item);
  }

  root.appendChild(wrap);
}
