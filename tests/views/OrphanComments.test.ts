import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { mountOrphanComments } from '../../src/views/OrphanComments';

function makeRoot(): HTMLElement {
  const root = document.createElement('div');
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe('OrphanComments', () => {
  it('renders an empty-state when there are no orphans', () => {
    const root = makeRoot();
    mountOrphanComments(root, {
      orphans: [],
      onRelocate: vi.fn(),
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    // No-orphans render path should leave nothing user-visible (or render an
    // explicit empty marker). The Document/Sidebar caller suppresses the
    // section entirely when the list is empty, so absence of articles is what
    // matters.
    expect(root.querySelector('[data-orphan-id]')).toBeNull();
  });

  it('renders Relocate / Keep / Delete actions for each orphan', () => {
    const root = makeRoot();
    const orphans = [
      {
        id: 't-9',
        anchor: { exact: 'gone phrase' },
        comments: [{ author: 'Alice', body: 'old note' }],
      },
    ];
    const onRelocate = vi.fn();
    const onKeep = vi.fn();
    const onDelete = vi.fn();
    mountOrphanComments(root, { orphans, onRelocate, onKeep, onDelete });
    const item = root.querySelector('[data-orphan-id="t-9"]')!;
    expect(item).toBeTruthy();
    expect(item.querySelector('[data-action="relocate"]')).toBeTruthy();
    expect(item.querySelector('[data-action="keep"]')).toBeTruthy();
    expect(item.querySelector('[data-action="delete"]')).toBeTruthy();
  });

  it('Relocate click invokes onRelocate with the thread id', () => {
    const root = makeRoot();
    const onRelocate = vi.fn();
    mountOrphanComments(root, {
      orphans: [
        {
          id: 't-1',
          anchor: { exact: 'phrase' },
          comments: [{ author: 'A', body: 'b' }],
        },
      ],
      onRelocate,
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    (root.querySelector('[data-action="relocate"]') as HTMLButtonElement).click();
    expect(onRelocate).toHaveBeenCalledWith('t-1');
  });

  it('Keep click invokes onKeep and visually marks the card as kept', () => {
    const root = makeRoot();
    const onKeep = vi.fn();
    mountOrphanComments(root, {
      orphans: [
        {
          id: 't-2',
          anchor: { exact: 'phrase' },
          comments: [{ author: 'A', body: 'b' }],
        },
      ],
      onRelocate: vi.fn(),
      onKeep,
      onDelete: vi.fn(),
    });
    const item = root.querySelector('[data-orphan-id="t-2"]') as HTMLElement;
    (item.querySelector('[data-action="keep"]') as HTMLButtonElement).click();
    expect(onKeep).toHaveBeenCalledWith('t-2');
    expect(item.classList.contains('kept')).toBe(true);
  });

  describe('Delete confirm flow', () => {
    let originalConfirm: typeof window.confirm;
    let confirmCalls: number;
    let confirmReturn: boolean;
    beforeEach(() => {
      originalConfirm = window.confirm;
      confirmCalls = 0;
      confirmReturn = true;
      window.confirm = (() => {
        confirmCalls += 1;
        return confirmReturn;
      }) as typeof window.confirm;
    });
    afterEach(() => {
      window.confirm = originalConfirm;
    });

    it('Delete click prompts confirm and calls onDelete when accepted', () => {
      const root = makeRoot();
      confirmReturn = true;
      const onDelete = vi.fn();
      mountOrphanComments(root, {
        orphans: [
          {
            id: 't-3',
            anchor: { exact: 'phrase' },
            comments: [{ author: 'A', body: 'b' }],
          },
        ],
        onRelocate: vi.fn(),
        onKeep: vi.fn(),
        onDelete,
      });
      (root.querySelector('[data-action="delete"]') as HTMLButtonElement).click();
      expect(confirmCalls).toBe(1);
      expect(onDelete).toHaveBeenCalledWith('t-3');
    });

    it('Delete click does not invoke onDelete when confirm is canceled', () => {
      const root = makeRoot();
      confirmReturn = false;
      const onDelete = vi.fn();
      mountOrphanComments(root, {
        orphans: [
          {
            id: 't-4',
            anchor: { exact: 'phrase' },
            comments: [{ author: 'A', body: 'b' }],
          },
        ],
        onRelocate: vi.fn(),
        onKeep: vi.fn(),
        onDelete,
      });
      (root.querySelector('[data-action="delete"]') as HTMLButtonElement).click();
      expect(confirmCalls).toBe(1);
      expect(onDelete).not.toHaveBeenCalled();
    });
  });

  it('uses textContent for the original quote and body so HTML cannot be injected', () => {
    const root = makeRoot();
    mountOrphanComments(root, {
      orphans: [
        {
          id: 't-x',
          anchor: { exact: '<script>bad()</script>' },
          comments: [{ author: '<img onerror=alert(1)>', body: '<b>nope</b>' }],
        },
      ],
      onRelocate: vi.fn(),
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(root.querySelector('script')).toBeNull();
    expect(root.querySelector('img')).toBeNull();
    // textContent rendering means the literal markup characters are present.
    expect(root.textContent).toContain('<script>bad()</script>');
    expect(root.textContent).toContain('<b>nope</b>');
  });

  it('rerenders cleanly when called twice (no leftover entries)', () => {
    const root = makeRoot();
    mountOrphanComments(root, {
      orphans: [
        {
          id: 't-1',
          anchor: { exact: 'first' },
          comments: [{ author: 'A', body: 'b' }],
        },
      ],
      onRelocate: vi.fn(),
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(root.querySelectorAll('[data-orphan-id]').length).toBe(1);
    mountOrphanComments(root, {
      orphans: [],
      onRelocate: vi.fn(),
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(root.querySelectorAll('[data-orphan-id]').length).toBe(0);
  });

  it('renders the original quote and the first comment body', () => {
    const root = makeRoot();
    mountOrphanComments(root, {
      orphans: [
        {
          id: 't-q',
          anchor: { exact: 'gone forever' },
          comments: [{ author: 'A', body: 'preserved note' }],
        },
      ],
      onRelocate: vi.fn(),
      onKeep: vi.fn(),
      onDelete: vi.fn(),
    });
    expect(root.textContent).toContain('gone forever');
    expect(root.textContent).toContain('preserved note');
  });

  it('handles orphans with no comments without throwing', () => {
    const root = makeRoot();
    expect(() => {
      mountOrphanComments(root, {
        orphans: [{ id: 't-n', anchor: { exact: 'gone' }, comments: [] }],
        onRelocate: vi.fn(),
        onKeep: vi.fn(),
        onDelete: vi.fn(),
      });
    }).not.toThrow();
    expect(root.querySelector('[data-orphan-id="t-n"]')).toBeTruthy();
  });
});
