import type { Hunk, Ipc } from '../ipc';

/**
 * Wireframe-08 conflict-diff view. Surfaces one row per `Hunk` returned
 * from `ipc.diffMd`, with Accept Left / Accept Right / Hand-edit controls.
 * On Finish merge, walks `hunks` × `choices` to assemble the resolved
 * bytes and persists them via `ipc.saveDocument`.
 *
 * ## Why the merge is computed in the frontend, not Rust
 *
 * The diff itself lives in Rust (`conflict.rs`) — that part of the design
 * is fixed. Replaying user choices into resolved bytes is a UI concern:
 * the user's hand-edited textarea contents only exist in the DOM, and a
 * round-trip to Rust just to splice strings would force every keystroke
 * onto the IPC channel.
 */
/**
 * Discriminator for the optional Drive-context banner. The two Drive code
 * paths into this view have very different mental models for the user
 * (DriveApi: "someone else uploaded a new revision while you were editing"
 * vs DriveDesktop: "your local sync client wrote new bytes to disk while
 * you were editing"), so wireframe-07 calls for two distinct banner copies
 * sharing the same diff-merge surface.
 */
export type DriveConflictSource = 'DriveApiEtag' | 'DriveDesktopWatcher';

export interface ConflictArgs {
  tabId: string;
  path: string;
  local: string;
  incoming: string;
  /**
   * If present, render the wireframe-07 Drive-context banner above the
   * diff. Omit (or pass `null` / `undefined`) for plain Local-backend
   * conflicts — those reuse the same view but must NOT show the
   * Drive-specific copy.
   */
  driveSource?: DriveConflictSource | null;
}

export interface ConflictHandle {
  /** Total hunks the user has not explicitly resolved (still on default). */
  unresolvedCount(): number;
}

/** A.9: document-level events LiveEditor (A.4) listens for to pause its
 * autosave/dirty pipeline while a conflict dialog is on screen. The
 * existing `conflict-resolved` event on the view element STAYS — it is
 * the Workspace listener's contract and still drives sidebar/tab
 * refreshes. The two document-level events live alongside it. */
const CONFLICT_OPEN_EVENT = 'mdviewer:conflict-open';
const CONFLICT_CLOSED_EVENT = 'mdviewer:conflict-closed';

export async function mountConflict(
  root: HTMLElement,
  ipc: Ipc,
  args: ConflictArgs,
): Promise<ConflictHandle> {
  root.replaceChildren();
  const view = document.createElement('section');
  view.setAttribute('data-view', 'conflict');
  view.className = 'conflict';

  // Tell LiveEditor (and any other listener that wants to suspend
  // background activity) that a conflict dialog has mounted. Fired on
  // `document` so the dispatch survives the conflict view being mounted
  // into a detached root in tests.
  document.dispatchEvent(new CustomEvent(CONFLICT_OPEN_EVENT, { bubbles: true }));

  // B5: wireframe-07 Drive-context banner. Hidden by default (Local-backend
  // conflicts) so the same view serves both audiences. The two Drive code
  // paths get distinct copy because the underlying root cause differs —
  // a 412 from the API means a remote collaborator pushed a new revision,
  // a watcher mismatch means the user's own Drive Desktop client touched
  // the file from another window.
  if (args.driveSource) {
    const banner = document.createElement('div');
    banner.className = 'drive-banner conflict-banner';
    banner.setAttribute('data-drive-source', args.driveSource);
    banner.textContent =
      args.driveSource === 'DriveApiEtag'
        ? 'Someone else updated this Drive file. Review both versions and merge.'
        : 'This Drive Desktop file changed on disk while you were editing. Review both versions and merge.';
    view.appendChild(banner);
  }

  const hunks = await ipc.diffMd(args.local, args.incoming);

  // Per-hunk choice. 'local' or 'incoming' are picked from the hunk's own
  // text; any other string is treated as a hand-edited override that the
  // textarea pushed in. Default 'local' so Finish merge always produces
  // deterministic bytes even if the user never touches the UI.
  const choices: ('local' | 'incoming' | string)[] = hunks.map(() => 'local');
  // Track which hunks the user has explicitly resolved so the status bar
  // can surface the unresolved count for wireframe-08's "N unresolved"
  // hint. A default 'local' choice still counts as unresolved until the
  // user clicks something.
  const explicitlyResolved = new Set<number>();

  const status = document.createElement('header');
  status.className = 'conflict-status';
  function refreshStatus(): void {
    const remaining = hunks.length - explicitlyResolved.size;
    status.textContent =
      remaining === 0
        ? `All ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} resolved.`
        : `${remaining} of ${hunks.length} hunk${hunks.length === 1 ? '' : 's'} unresolved.`;
  }
  refreshStatus();
  view.appendChild(status);

  hunks.forEach((h, i) => {
    const row = document.createElement('article');
    row.setAttribute('data-hunk-index', String(i));
    row.className = `hunk hunk-${h.kind}`;

    const left = document.createElement('pre');
    left.className = 'left';
    left.textContent = h.local_text;
    const right = document.createElement('pre');
    right.className = 'right';
    right.textContent = h.incoming_text;

    const acceptL = document.createElement('button');
    acceptL.setAttribute('data-action', 'accept-left');
    acceptL.textContent = 'Accept Left';
    acceptL.addEventListener('click', () => {
      choices[i] = 'local';
      explicitlyResolved.add(i);
      row.classList.remove('chose-right', 'chose-edit');
      row.classList.add('chose-left');
      refreshStatus();
    });

    const acceptR = document.createElement('button');
    acceptR.setAttribute('data-action', 'accept-right');
    acceptR.textContent = 'Accept Right';
    acceptR.addEventListener('click', () => {
      choices[i] = 'incoming';
      explicitlyResolved.add(i);
      row.classList.remove('chose-left', 'chose-edit');
      row.classList.add('chose-right');
      refreshStatus();
    });

    const handEdit = document.createElement('button');
    handEdit.setAttribute('data-action', 'hand-edit');
    handEdit.textContent = 'Hand-edit';
    handEdit.addEventListener('click', () => {
      // The textarea is created lazily — clicking Hand-edit a second time
      // should NOT stack textareas, so bail if one already exists.
      if (row.querySelector('textarea[data-role="hand-edit"]')) return;
      const ta = document.createElement('textarea');
      ta.setAttribute('data-role', 'hand-edit');
      ta.value = choices[i] === 'incoming' ? h.incoming_text : h.local_text;
      // Seed the choice immediately so an empty edit is still treated as
      // an explicit user decision (otherwise the default 'local' would
      // leak through if the user opens the textarea and clicks Finish).
      choices[i] = ta.value;
      explicitlyResolved.add(i);
      row.classList.remove('chose-left', 'chose-right');
      row.classList.add('chose-edit');
      ta.addEventListener('input', () => {
        choices[i] = ta.value;
        refreshStatus();
      });
      row.appendChild(ta);
      refreshStatus();
    });

    row.append(left, right, acceptL, acceptR, handEdit);
    view.appendChild(row);
  });

  const finish = document.createElement('button');
  finish.setAttribute('data-action', 'finish-merge');
  finish.className = 'finish-merge';
  finish.textContent = 'Finish merge';
  finish.addEventListener('click', async () => {
    const merged = mergeBytes(args.local, args.incoming, hunks, choices);
    // B2: saveDocument now takes tabId (not path) and returns SaveOutcome.
    // The Conflict view discards the return — the merge is the user's
    // explicit resolution, so we never re-enter the conflict loop here.
    await ipc.saveDocument(args.tabId, merged);
    view.dispatchEvent(
      new CustomEvent('conflict-resolved', {
        bubbles: true,
        detail: { path: args.path, tabId: args.tabId },
      }),
    );
    // A.9: signal LiveEditor that the conflict dialog is going away so
    // it can resume autosave / dirty propagation. Fired on `document`
    // for the same reason `conflict-open` is — listeners attach there.
    document.dispatchEvent(new CustomEvent(CONFLICT_CLOSED_EVENT, { bubbles: true }));
  });
  view.appendChild(finish);

  root.appendChild(view);

  return {
    unresolvedCount: () => hunks.length - explicitlyResolved.size,
  };
}

/**
 * Walk both sides line-by-line and emit the chosen replacement per hunk.
 * Outside any hunk, the lines are identical (that's why the diff didn't
 * include them) so we copy from `local`. Inside a hunk, the choice picks
 * which slice to emit; any string that isn't 'local' or 'incoming' is
 * treated as a hand-edit override.
 */
export function mergeBytes(
  local: string,
  incoming: string,
  hunks: Hunk[],
  choices: (string | 'local' | 'incoming')[],
): string {
  const localLines = local.split('\n');
  const incomingLines = incoming.split('\n');
  const out: string[] = [];
  let cursor = 0;
  for (let i = 0; i < hunks.length; i++) {
    const h = hunks[i];
    const choice = choices[i];
    while (cursor < h.local_range[0]) {
      out.push(localLines[cursor++]);
    }
    if (choice === 'local') {
      for (let l = h.local_range[0]; l < h.local_range[1]; l++) {
        out.push(localLines[l]);
      }
    } else if (choice === 'incoming') {
      for (let l = h.incoming_range[0]; l < h.incoming_range[1]; l++) {
        out.push(incomingLines[l]);
      }
    } else {
      // Hand-edit — `choice` is the literal user-edited string. Split
      // on \n so multi-line edits land as separate elements (the join
      // below glues them back with the same separator).
      out.push(...choice.split('\n'));
    }
    cursor = h.local_range[1];
  }
  while (cursor < localLines.length) {
    out.push(localLines[cursor++]);
  }
  return out.join('\n');
}
