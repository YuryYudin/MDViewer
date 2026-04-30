import { describe, it, expect, vi, afterEach } from 'vitest';
import { mountEdit } from '../../src/views/Edit';

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('Edit', () => {
  it('mounts a textarea pre-filled with the source', () => {
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: 'hello',
      autoSave: true,
      autoSaveDebounceMs: 750,
      wordWrap: false,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    expect(ta).toBeTruthy();
    expect(ta.value).toBe('hello');
  });

  it('debounces keystrokes and calls saveDocument at the configured interval', async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: 'hello',
      autoSave: true,
      autoSaveDebounceMs: 750,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'hello world';
    ta.dispatchEvent(new Event('input'));
    expect(ipc.saveDocument).not.toHaveBeenCalled();
    vi.advanceTimersByTime(749);
    expect(ipc.saveDocument).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    await Promise.resolve();
    expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'hello world');
  });

  it('cancels prior debounce when another keystroke arrives within the window', async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: true,
      autoSaveDebounceMs: 500,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'a';
    ta.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    ta.value = 'ab';
    ta.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(400);
    expect(ipc.saveDocument).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    await Promise.resolve();
    expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
    expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'ab');
  });

  it('reflects word_wrap and show_whitespace settings on the textarea', () => {
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn() };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: true,
      autoSaveDebounceMs: 750,
      wordWrap: false,
      showWhitespace: true,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    expect(ta.classList.contains('show-whitespace')).toBe(true);
    expect(ta.style.whiteSpace).toBe('pre');
  });

  it('uses pre-wrap when wordWrap is on', () => {
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn() };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: true,
      autoSaveDebounceMs: 750,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    expect(ta.style.whiteSpace).toBe('pre-wrap');
    expect(ta.classList.contains('show-whitespace')).toBe(false);
  });

  it('forceSave flushes pending save immediately and cancels the timer', async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    const view = mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: true,
      autoSaveDebounceMs: 1000,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'fresh';
    ta.dispatchEvent(new Event('input'));
    await view.forceSave();
    expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
    // B2: saveDocument now takes tabId (not path) so dispatch can pick the
    // right backend without re-deriving it from the path.
    expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'fresh');
    // Advance past the original debounce window — pending timer should have
    // been canceled when forceSave ran, so the count stays at 1.
    vi.advanceTimersByTime(2000);
    await Promise.resolve();
    expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
  });

  it('manual Save button triggers an immediate saveDocument call', async () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: 'init',
      autoSave: true,
      autoSaveDebounceMs: 1000,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'updated';
    ta.dispatchEvent(new Event('input'));
    const btn = root.querySelector<HTMLButtonElement>('[data-action="save"]')!;
    btn.click();
    await Promise.resolve();
    await Promise.resolve();
    // B2: saveDocument now takes tabId (not path).
    expect(ipc.saveDocument).toHaveBeenCalledWith('t', 'updated');
    expect(ipc.saveDocument).toHaveBeenCalledTimes(1);
  });

  it('does not autosave when autoSave is false', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: false,
      autoSaveDebounceMs: 100,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'never saved';
    ta.dispatchEvent(new Event('input'));
    vi.advanceTimersByTime(10000);
    expect(ipc.saveDocument).not.toHaveBeenCalled();
  });

  it('currentSource() returns the live textarea contents', () => {
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn() };
    const view = mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: 'a',
      autoSave: true,
      autoSaveDebounceMs: 1,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'a edited';
    expect(view.currentSource()).toBe('a edited');
  });

  it('destroy() removes the textarea and prevents pending save from firing', () => {
    vi.useFakeTimers();
    const root = makeRoot();
    const ipc: any = { saveDocument: vi.fn().mockResolvedValue(undefined) };
    const view = mountEdit(root, ipc, {
      tabId: 't',
      path: '/tmp/a.md',
      source: '',
      autoSave: true,
      autoSaveDebounceMs: 500,
      wordWrap: true,
      showWhitespace: false,
    });
    const ta = root.querySelector<HTMLTextAreaElement>('[data-test="editor"]')!;
    ta.value = 'x';
    ta.dispatchEvent(new Event('input'));
    view.destroy();
    vi.advanceTimersByTime(1000);
    expect(ipc.saveDocument).not.toHaveBeenCalled();
    expect(root.querySelector('[data-test="editor"]')).toBeNull();
  });
});
