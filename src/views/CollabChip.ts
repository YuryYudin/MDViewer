import type { DriveCollaborator } from '../types-generated';
import { initials } from './collabInitials';

/**
 * Maximum number of avatar bubbles rendered inline before the chip
 * collapses the rest into a `+N` overflow pill. Matches wireframe-05's
 * pattern; bumping this is fine but the fixed-width sidebar header
 * starts to crowd around 6–7 avatars on narrow windows.
 */
const VISIBLE_CAP = 5;

export interface CollabChipDeps {
  /** Drive `file_id` for the active tab. Passed through to `collaboratorsLoader`
   *  so the same chip implementation works for both DriveDesktop tabs (file_id
   *  resolved by the watcher) and DriveApi tabs (file_id derived from the
   *  `drive-api://<file_id>` synthetic path). */
  fileId: string;
  /** Async loader returning the list of collaborators for `fileId`. In
   *  production this is the typed `driveGetCollaborators` IPC wrapper from
   *  `src/ipc.ts`; tests pass a stubbed async function so the chip can
   *  exercise its render paths without a Tauri runtime. */
  collaboratorsLoader: (fileId: string) => Promise<DriveCollaborator[]>;
}

/**
 * Mount the collaborator chip into `host`. The chip:
 *
 *   * Calls `collaboratorsLoader(fileId)` exactly once on mount and caches
 *     the result in the closure. Re-fetching on every render would burn
 *     Drive API quota — the polling loop (B6) is the right place to hint
 *     a refresh when permissions change is suspected; a follow-up patch
 *     can expose a `refresh()` callback off the disposer.
 *   * Renders `initials(display_name)` in a `.collab-avatar` span per
 *     collaborator (capped at VISIBLE_CAP). The `title` attribute carries
 *     the full `Name <email>` string so hovering surfaces the identity
 *     without needing a tooltip component.
 *   * Renders a single `.collab-overflow` span with `+N` text when more
 *     than VISIBLE_CAP collaborators are present.
 *   * **Never renders an `<img>`.** The wireframe pins us to initials-only
 *     because Drive's `photoLink` requires `drive.readonly` or broader
 *     scope, and we ship `drive.file` only — see the avoid-list in C1.
 *   * Swallows loader errors silently so a transient network blip doesn't
 *     surface as an in-chip error state. The chip simply stays empty.
 *
 * Returns a disposer that empties the host element. The host gets a
 * `collab-chip` class added so the parent stylesheet's flex/gap rule
 * applies.
 */
export function mountCollabChip(host: HTMLElement, deps: CollabChipDeps): () => void {
  host.classList.add('collab-chip');
  let list: DriveCollaborator[] = [];

  const render = (): void => {
    while (host.firstChild) host.removeChild(host.firstChild);
    if (list.length === 0) return;
    const visible = list.slice(0, VISIBLE_CAP);
    for (const c of visible) {
      const avatar = document.createElement('span');
      avatar.className = 'collab-avatar';
      avatar.setAttribute('title', `${c.display_name} <${c.email_address}>`);
      avatar.textContent = initials(c.display_name, c.email_address);
      host.appendChild(avatar);
    }
    if (list.length > VISIBLE_CAP) {
      const overflow = document.createElement('span');
      overflow.className = 'collab-overflow';
      overflow.textContent = `+${list.length - VISIBLE_CAP}`;
      host.appendChild(overflow);
    }
  };

  // Fire-and-forget; a failed loader leaves the chip empty (see doc-comment).
  // Cache the resolved list in the closure so a subsequent render call
  // (currently not exposed; reserved for a refresh hook) doesn't re-fetch.
  void deps
    .collaboratorsLoader(deps.fileId)
    .then((cs) => {
      list = cs ?? [];
      render();
    })
    .catch(() => {
      // Best-effort: an offline / 5xx / scope-mismatch response shouldn't
      // surface as a chrome error. The CommentsSidebar still renders.
    });

  return () => {
    while (host.firstChild) host.removeChild(host.firstChild);
  };
}
