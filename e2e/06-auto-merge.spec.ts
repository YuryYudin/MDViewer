// CRDT-only behavior: Phase 1's plain-JSON sidecar cannot merge two divergent
// histories (newest-mtime-wins would silently drop one side's reply). The spec
// stays RED through Phase 1/2 and turns green at C1 (Automerge sidecar) which
// is the first phase that can union both replies on t-1.

import fs from 'node:fs/promises';
import path from 'node:path';
import { prepareFixture } from './helpers/app';

describe('Auto-merge two divergent sidecar histories', () => {
  let fixture: Awaited<ReturnType<typeof prepareFixture>>;

  before(async () => {
    fixture = await prepareFixture({ fixtureDir: path.resolve('e2e/fixtures') });
  });
  after(async () => { await fixture.cleanup(); });

  it('unions both divergent replies on t-1 and surfaces the net-new t-3 thread', async () => {
    await browser.$('[data-action="open-file"]').click();
    const filePath = await browser.uploadFile(path.resolve('e2e/fixtures/sample.md'));
    await browser.$('[data-test="file-input"]').setValue(filePath);

    // Simulate an "incoming" sidecar: a sibling copy with a divergent reply on
    // t-1 plus a net-new thread t-3. Newest-mtime-wins would drop one of the
    // t-1 replies, so the spec only passes once a CRDT merge is in place.
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

    // Trigger Import.
    await browser.$('[data-action="import-comments"]').click();
    await browser.$('[data-test="import-path"]').setValue(incomingPath);
    await browser.$('[data-action="confirm-import"]').click();

    // Sidebar shows three threads; t-1 has two replies (the local + incoming).
    const threads = await browser.$$('[data-view="sidebar-comments"] [data-test="thread"]');
    await expect(threads).toBeElementsArrayOfSize(3);

    const t1Replies = await browser.$$('[data-test="thread"][data-thread-id="t-1"] [data-test="comment"]');
    await expect(t1Replies).toBeElementsArrayOfSize(2);
  });
});
