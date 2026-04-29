import type { ExportResult, Ipc } from '../ipc';

/**
 * Wireframe-10 share dialog: shows the filenames that will land in the
 * destination folder, lets the user pick the folder, and runs
 * `ipc.exportDocument` on Export. The receiver-side workflow rests on
 * the design's Key Decision to ship a plain folder (no zip) so the
 * receiver can open the `.md` in any editor.
 */
export interface ShareDialogArgs {
  tabId: string;
  /** Absolute path to the open .md — only used to derive preview filenames. */
  path: string;
  /**
   * Optional override for the sidecar filename pattern. Defaults to
   * `<basename>.comments.json` to mirror the Rust `sidecar_pattern`
   * default — keeps the preview honest without an extra IPC round-trip
   * just to fetch settings.
   */
  sidecarSuffix?: string;
}

export async function mountShareDialog(
  root: HTMLElement,
  ipc: Ipc,
  args: ShareDialogArgs,
): Promise<void> {
  root.replaceChildren();
  const view = document.createElement('section');
  view.setAttribute('data-view', 'share');
  view.className = 'share-dialog';

  const heading = document.createElement('h2');
  heading.textContent = 'Share document';
  view.appendChild(heading);

  const explainer = document.createElement('p');
  explainer.textContent =
    'MDViewer will export the markdown plus its comments sidecar to a folder you pick. Send both files to your reviewer.';
  view.appendChild(explainer);

  const baseName = basenameFromPath(args.path);
  const sidecarSuffix = args.sidecarSuffix ?? '.comments.json';
  const previewNames = [baseName, `${baseName}${sidecarSuffix}`];

  const list = document.createElement('ul');
  list.className = 'preview-list';
  for (const name of previewNames) {
    const li = document.createElement('li');
    li.setAttribute('data-test', 'preview-name');
    li.textContent = name;
    list.appendChild(li);
  }
  view.appendChild(list);

  const folderLabel = document.createElement('label');
  folderLabel.textContent = 'Destination folder';
  const folder = document.createElement('input');
  folder.setAttribute('data-test', 'folder');
  folder.type = 'text';
  folder.placeholder = 'Choose a folder…';
  folderLabel.appendChild(folder);
  view.appendChild(folderLabel);

  const error = document.createElement('p');
  error.className = 'error';
  error.setAttribute('data-test', 'error');
  error.hidden = true;
  view.appendChild(error);

  const cancel = document.createElement('button');
  cancel.setAttribute('data-action', 'cancel');
  cancel.type = 'button';
  cancel.textContent = 'Cancel';
  cancel.addEventListener('click', () => {
    view.dispatchEvent(new CustomEvent('share-dismissed', { bubbles: true }));
  });

  const exp = document.createElement('button');
  exp.setAttribute('data-action', 'export');
  exp.type = 'button';
  exp.textContent = 'Export';
  exp.addEventListener('click', async () => {
    error.hidden = true;
    if (!folder.value.trim()) {
      error.textContent = 'Pick a destination folder before exporting.';
      error.hidden = false;
      return;
    }
    try {
      const result: ExportResult = await ipc.exportDocument({
        tabId: args.tabId,
        folder: folder.value,
      });
      view.dispatchEvent(
        new CustomEvent('share-exported', { bubbles: true, detail: result }),
      );
    } catch (e) {
      // Surface the Rust error verbatim — the most common case is the
      // "export folder is not empty" guardrail and the user needs to
      // see it to pick a different folder.
      error.textContent = String(e);
      error.hidden = false;
    }
  });

  view.append(cancel, exp);
  root.appendChild(view);
}

function basenameFromPath(p: string): string {
  // Mirror std::path::Path::file_name semantics on both POSIX and Windows
  // by splitting on the last separator of either flavor.
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}
