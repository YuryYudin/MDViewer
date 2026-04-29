import { describe, it, expect, vi } from 'vitest';
import { mountShareDialog } from '../../src/views/ShareDialog';
import type { ExportResult, Ipc } from '../../src/ipc';

function ipcStub(
  exportDocument = vi.fn().mockResolvedValue({
    folder: '/tmp/out',
    files: ['doc.md', 'doc.md.comments.json'],
  } as ExportResult),
): Ipc {
  return {
    appInfo: vi.fn(),
    openDocument: vi.fn(),
    closeTab: vi.fn(),
    activateTab: vi.fn(),
    listOpenDocuments: vi.fn(),
    listRecents: vi.fn(),
    getSettings: vi.fn(),
    setSettings: vi.fn(),
    listThreads: vi.fn(),
    createThread: vi.fn(),
    postReply: vi.fn(),
    resolveThread: vi.fn(),
    renderMarkdown: vi.fn(),
    resolveAnchor: vi.fn(),
    saveDocument: vi.fn(),
    setDirty: vi.fn(),
    diffMd: vi.fn(),
    exportDocument,
  } as unknown as Ipc;
}

describe('ShareDialog', () => {
  it('matches wireframe 10 (preview filenames + Cancel/Export)', async () => {
    const root = document.createElement('div');
    await mountShareDialog(root, ipcStub(), { tabId: 't', path: '/tmp/doc.md' });
    expect(root.querySelector('[data-view="share"]')).toBeTruthy();
    const previews = root.querySelectorAll('[data-test="preview-name"]');
    expect(previews).toHaveLength(2);
    expect(previews[0].textContent).toBe('doc.md');
    expect(previews[1].textContent).toBe('doc.md.comments.json');
    expect(root.querySelector('[data-action="export"]')).toBeTruthy();
    expect(root.querySelector('[data-action="cancel"]')).toBeTruthy();
  });

  it('clicking Export calls exportDocument with the chosen folder', async () => {
    const root = document.createElement('div');
    const exportDocument = vi.fn().mockResolvedValue({
      folder: '/tmp/out',
      files: ['doc.md', 'doc.md.comments.json'],
    } as ExportResult);
    await mountShareDialog(root, ipcStub(exportDocument), { tabId: 't', path: '/tmp/doc.md' });
    (root.querySelector<HTMLInputElement>('[data-test="folder"]')!).value = '/tmp/out';
    (root.querySelector('[data-action="export"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(exportDocument).toHaveBeenCalledWith({ tabId: 't', folder: '/tmp/out' });
  });

  it('refuses to export when the folder field is blank', async () => {
    const root = document.createElement('div');
    const exportDocument = vi.fn();
    await mountShareDialog(root, ipcStub(exportDocument), { tabId: 't', path: '/tmp/doc.md' });
    (root.querySelector('[data-action="export"]') as HTMLButtonElement).click();
    await Promise.resolve();
    expect(exportDocument).not.toHaveBeenCalled();
    const err = root.querySelector<HTMLElement>('[data-test="error"]')!;
    expect(err.hidden).toBe(false);
  });

  it('surfaces a Rust error when the destination folder is non-empty', async () => {
    const root = document.createElement('div');
    const exportDocument = vi
      .fn()
      .mockRejectedValue(new Error('export folder is not empty'));
    await mountShareDialog(root, ipcStub(exportDocument), { tabId: 't', path: '/tmp/doc.md' });
    (root.querySelector<HTMLInputElement>('[data-test="folder"]')!).value = '/tmp/out';
    (root.querySelector('[data-action="export"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    const err = root.querySelector<HTMLElement>('[data-test="error"]')!;
    expect(err.hidden).toBe(false);
    expect(err.textContent).toContain('export folder is not empty');
  });

  it('emits share-exported with the result on success', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const listener = vi.fn();
    root.addEventListener('share-exported', listener);
    await mountShareDialog(root, ipcStub(), { tabId: 't', path: '/tmp/doc.md' });
    (root.querySelector<HTMLInputElement>('[data-test="folder"]')!).value = '/tmp/out';
    (root.querySelector('[data-action="export"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    document.body.removeChild(root);
  });

  it('emits share-dismissed when Cancel is clicked', async () => {
    const root = document.createElement('div');
    document.body.appendChild(root);
    const listener = vi.fn();
    root.addEventListener('share-dismissed', listener);
    await mountShareDialog(root, ipcStub(), { tabId: 't', path: '/tmp/doc.md' });
    (root.querySelector('[data-action="cancel"]') as HTMLButtonElement).click();
    expect(listener).toHaveBeenCalled();
    document.body.removeChild(root);
  });

  it('handles Windows-style paths in the basename helper', async () => {
    const root = document.createElement('div');
    await mountShareDialog(root, ipcStub(), { tabId: 't', path: 'C:\\docs\\spec.md' });
    const previews = root.querySelectorAll('[data-test="preview-name"]');
    expect(previews[0].textContent).toBe('spec.md');
  });

  it('honors a custom sidecarPattern that uses {name} substitution', async () => {
    // Mirrors the Rust comments.sidecar_pattern setting: `{name}` is the
    // file stem. Without this branch the preview filename would silently
    // disagree with the bytes export_document writes.
    const root = document.createElement('div');
    await mountShareDialog(root, ipcStub(), {
      tabId: 't',
      path: '/tmp/spec.md',
      sidecarPattern: '.{name}.comments',
    });
    const previews = root.querySelectorAll('[data-test="preview-name"]');
    expect(previews[1].textContent).toBe('.spec.comments');
  });

  it('falls back to the legacy sidecarSuffix shape when no pattern is set', async () => {
    const root = document.createElement('div');
    await mountShareDialog(root, ipcStub(), {
      tabId: 't',
      path: '/tmp/spec.md',
      sidecarSuffix: '.notes.json',
    });
    const previews = root.querySelectorAll('[data-test="preview-name"]');
    expect(previews[1].textContent).toBe('spec.md.notes.json');
  });

  it('emits share-exported with the result on success', async () => {
    // Duplicate of an earlier test, kept here so the focused test file is
    // self-contained when run in isolation.
    const root = document.createElement('div');
    document.body.appendChild(root);
    const listener = vi.fn();
    root.addEventListener('share-exported', listener);
    await mountShareDialog(root, ipcStub(), {
      tabId: 't',
      path: '/tmp/doc.md',
      sidecarPattern: '{name}.md.comments.json',
    });
    (root.querySelector<HTMLInputElement>('[data-test="folder"]')!).value = '/tmp/out';
    (root.querySelector('[data-action="export"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(listener).toHaveBeenCalled();
    document.body.removeChild(root);
  });
});
