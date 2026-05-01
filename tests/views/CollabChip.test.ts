import { describe, it, expect, vi } from 'vitest';
import { mountCollabChip } from '../../src/views/CollabChip';

// Helper to flush a couple of microtask turns. mountCollabChip kicks off
// `loader().then(render)` synchronously; one `await Promise.resolve()` lets
// the loader's resolved value land in the .then, the second lets the render
// run. Two turns is the same pattern the rest of the view tests use for
// async-in-mount components.
async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('CollabChip', () => {
  it('renders one avatar per collaborator (initials only, no photoLink)', async () => {
    const root = document.createElement('div');
    const collaborators = [
      { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
      { display_name: 'Bob Beam', email_address: 'bob@example.com' },
    ];
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => collaborators,
    });
    await flush();
    const avatars = root.querySelectorAll('.collab-avatar');
    expect(avatars.length).toBe(2);
    expect(avatars[0].textContent).toBe('AA');
    expect(avatars[1].textContent).toBe('BB');
    // Initials-only — no <img> tag (we don't request photoLink because
    // that would require drive.readonly scope; we ship drive.file only).
    expect(root.querySelector('img')).toBeNull();
  });

  it('shows +N overflow when more than 5 collaborators', async () => {
    const collaborators = Array.from({ length: 8 }, (_, i) => ({
      display_name: `User ${i}`,
      email_address: `u${i}@example.com`,
    }));
    const root = document.createElement('div');
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => collaborators,
    });
    await flush();
    expect(root.querySelectorAll('.collab-avatar').length).toBe(5);
    expect(root.querySelector('.collab-overflow')?.textContent).toBe('+3');
  });

  it('renders nothing when the loader returns an empty list', async () => {
    const root = document.createElement('div');
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => [],
    });
    await flush();
    expect(root.querySelector('.collab-avatar')).toBeFalsy();
    expect(root.querySelector('.collab-overflow')).toBeFalsy();
  });

  it('swallows loader errors and leaves the host empty', async () => {
    const root = document.createElement('div');
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => {
        throw new Error('boom');
      },
    });
    await flush();
    expect(root.querySelector('.collab-avatar')).toBeFalsy();
  });

  it('passes the fileId through to the loader', async () => {
    const root = document.createElement('div');
    const loader = vi.fn().mockResolvedValue([]);
    mountCollabChip(root, {
      fileId: 'FILE-XYZ',
      collaboratorsLoader: loader,
    });
    await flush();
    expect(loader).toHaveBeenCalledWith('FILE-XYZ');
  });

  it('uses the email-prefix initials when display_name is empty', async () => {
    // Drive permissions can lack a displayName for accounts that haven't
    // populated their profile. Falling back to "?" is uglier than falling
    // back to the email's first character so we don't print a literal
    // question-mark in the chip.
    const root = document.createElement('div');
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => [
        { display_name: '', email_address: 'zoe@example.com' },
      ],
    });
    await flush();
    expect(root.querySelector('.collab-avatar')?.textContent).toBe('Z');
  });

  it('returns a disposer that clears the host', async () => {
    const root = document.createElement('div');
    const dispose = mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => [
        { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
      ],
    });
    await flush();
    expect(root.querySelector('.collab-avatar')).toBeTruthy();
    dispose();
    expect(root.querySelector('.collab-avatar')).toBeFalsy();
  });

  it('sets a tooltip combining display_name and email', async () => {
    const root = document.createElement('div');
    mountCollabChip(root, {
      fileId: 'FID',
      collaboratorsLoader: async () => [
        { display_name: 'Alice Anderson', email_address: 'alice@example.com' },
      ],
    });
    await flush();
    const avatar = root.querySelector('.collab-avatar')!;
    expect(avatar.getAttribute('title')).toBe('Alice Anderson <alice@example.com>');
  });
});
