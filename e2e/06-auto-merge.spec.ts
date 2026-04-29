import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture, openDocByE2eHook, importCommentsByE2eHook } from './helpers/app';

describe('Auto-merge two divergent sidecar histories', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('unions both divergent replies on t-1 and surfaces the net-new t-3 thread', async () => {
    const target = path.join(fixture.tmpDir, 'sample.md');
    await openDocByE2eHook(target);
    await browser.waitUntil(
      async () => browser.$('[data-view="document"]').isExisting(),
      { timeout: 10_000, timeoutMsg: 'document view did not mount' },
    );

    // Write the incoming sidecar — schema_version 1 lets us hand-write
    // it via JSON; load_sidecar migrates v1 in-memory before merge.
    const incoming = {
      schema_version: 1,
      threads: [
        {
          id: 't-1',
          anchor: {
            start: 96, end: 118,
            exact: 'Selectable phrase one.',
            prefix: 'Section Two\n\n', suffix: ' Selectable phrase two.',
          },
          comments: [
            { id: 'c-1', author: 'Alice', color: '#ff8800', body: 'Looks good',
              created_at: '2026-04-01T12:00:00Z' },
            { id: 'c-1b', author: 'Mira', color: '#888888', body: 'Incoming reply on t-1',
              created_at: '2026-04-02T14:00:00Z' },
          ],
          resolved: false,
        },
        {
          id: 't-3',
          anchor: {
            start: 119, end: 141,
            exact: 'Selectable phrase two.',
            prefix: 'Selectable phrase one. ', suffix: '\n\n```rust',
          },
          comments: [
            { id: 'c-3', author: 'Mira', color: '#888888', body: 'Net-new thread',
              created_at: '2026-04-02T15:00:00Z' },
          ],
          resolved: false,
        },
      ],
    };
    const incomingPath = path.join(fixture.tmpDir, 'incoming.md.comments.json');
    await fs.writeFile(incomingPath, JSON.stringify(incoming) + '\n', 'utf8');

    // Discover the active tab id from the TabBar.
    const tabId = (await browser
      .$('[data-region="tabbar"] [data-test="tab"]')
      .getAttribute('data-tab-id')) ?? '';
    expect(tabId).toBeTruthy();

    await importCommentsByE2eHook(tabId, incomingPath);

    // Wait for the post-import refresh to land in the sidebar.
    await browser.waitUntil(
      async () => {
        const threads = await browser.$$(
          '[data-view="sidebar-comments"] [data-test="thread"]',
        );
        return threads.length === 3;
      },
      { timeout: 5_000, timeoutMsg: 'expected 3 threads after merge' },
    ).catch(async () => {
      const dump = await browser.execute(() => {
        const ts = Array.from(
          document.querySelectorAll('[data-view="sidebar-comments"] [data-test="thread"]'),
        );
        return ts.map((t) => (t as HTMLElement).getAttribute('data-thread-id'));
      });
      throw new Error(`expected 3 threads, got: ${JSON.stringify(dump)}`);
    });

    // t-1 should now have 2 comments (the local "Looks good" + the
    // incoming "Incoming reply on t-1"). The post-merge union dedupes
    // by comment id and sorts by created_at.
    const t1Comments = await browser.$$(
      '[data-test="thread"][data-thread-id="t-1"] [data-test="thread-comment"]',
    );
    expect(t1Comments.length).toBe(2);
  });
});
