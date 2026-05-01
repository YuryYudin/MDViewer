/**
 * In-process mock Google Drive server used by the C3 e2e spec.
 *
 * Stands up a tiny HTTP server on a random localhost port and serves the
 * subset of OAuth + Drive REST endpoints the production code touches. The
 * spec exports the bound `base` URL via the `MDVIEWER_DRIVE_API_BASE`,
 * `MDVIEWER_DRIVE_AUTH_BASE`, and `MDVIEWER_DRIVE_TOKEN_BASE` env vars so
 * the Rust side (see `src-tauri/src/drive/api.rs` + `auth.rs`) routes its
 * requests to us instead of `googleapis.com`.
 *
 * Endpoints implemented:
 *   GET  /o/oauth2/v2/auth                     — captures URL + 302s back to redirect_uri
 *   POST /token                                — issues a fixed access/refresh token + id_token
 *   GET  /drive/v3/files/{id}                  — JSON metadata
 *   GET  /drive/v3/files/{id}?alt=media        — raw bytes (with ETag header)
 *   PATCH /upload/drive/v3/files/{id}          — write w/ If-Match precondition (412 on mismatch)
 *   GET  /drive/v3/files/{id}/comments         — list
 *   POST /drive/v3/files/{id}/comments         — create
 *   GET  /drive/v3/files/{id}/permissions      — list
 *
 * State is exposed via the returned handle so individual scenarios can
 * mutate or inspect it (push a comment from "peer B", flip the etag to
 * force a conflict, read the captured authorize URL, toggle offline).
 *
 * NOT a real OAuth implementation: state-token validation, scope
 * negotiation, refresh-token rotation, etc. are all out of scope. The
 * goal is exercising the *production* code paths from above — the mock
 * just has to look enough like Google for the client to keep going.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

interface MockFile {
  name: string;
  etag: string;
  body: string;
}

interface MockComment {
  id: string;
  content: string;
  quotedFileContent?: { value: string };
  modifiedTime: string;
  resolved: boolean;
  replies: unknown[];
  author?: { displayName: string; emailAddress: string };
}

interface MockPermission {
  displayName: string;
  emailAddress: string;
}

export interface MockState {
  files: Map<string, MockFile>;
  comments: Map<string, MockComment[]>;
  permissions: Map<string, MockPermission[]>;
  /** Authorization-code returned in the 302 redirect after `/o/oauth2/v2/auth`. */
  authCode: string;
  /** Every full request URL the app has hit on `/o/oauth2/v2/auth`. The BYO
   *  scenario asserts the latest entry contains `client_id=<byo-id>`. */
  capturedAuthorizeUrls: string[];
  /** When true, every endpoint returns a network-style failure (500) — used
   *  by the offline-write-then-replay scenario to simulate a dropped link
   *  without actually closing the listener (which would change the port). */
  offline: boolean;
}

export interface DriveMock {
  /** The `http://127.0.0.1:<port>` base. */
  base: string;
  /** The authorize URL — `<base>/o/oauth2/v2/auth`. */
  authBase: string;
  /** The token URL — `<base>/token`. */
  tokenBase: string;
  state: MockState;
  /** Append a Drive comment as if pushed by another collaborator. The next
   *  poll the production code does will pick it up. */
  pushComment: (fileId: string, content: string, quoted?: string) => void;
  /** Flip the cached etag for a file so the next save sees a 412 conflict. */
  bumpEtag: (fileId: string, newEtag: string) => void;
  /** Toggle the simulated offline mode. */
  setOffline: (offline: boolean) => void;
  close: () => Promise<void>;
}

function defaultState(): MockState {
  return {
    files: new Map([
      [
        'FID1',
        {
          name: 'shared-notes.md',
          etag: 'W/"v1"',
          body: '# shared notes\n\noriginal content\n',
        },
      ],
    ]),
    comments: new Map([['FID1', []]]),
    permissions: new Map([
      [
        'FID1',
        [
          { displayName: 'Alice Anderson', emailAddress: 'alice@example.com' },
          { displayName: 'Bob Beam', emailAddress: 'bob@example.com' },
        ],
      ],
    ]),
    authCode: 'auth-code-123',
    capturedAuthorizeUrls: [],
    offline: false,
  };
}

function fileIdFromPath(pathname: string, idIndex: number): string | null {
  const parts = pathname.split('/');
  return parts[idIndex] ?? null;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (chunk) => {
      buf += chunk;
    });
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

export async function startDriveMock(): Promise<DriveMock> {
  const state = defaultState();

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://x');

    // Belt-and-suspenders error handling: any thrown handler becomes a 500
    // so the harness keeps running and the spec sees the failure.
    void (async () => {
      try {
        if (state.offline) {
          res.writeHead(500, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ error: { code: 500, message: 'offline (simulated)' } }));
          return;
        }

        // ── OAuth: authorize ─────────────────────────────────────────────
        if (url.pathname === '/o/oauth2/v2/auth') {
          state.capturedAuthorizeUrls.push(req.url ?? '');
          const redirectUri = url.searchParams.get('redirect_uri');
          const stateParam = url.searchParams.get('state') ?? '';
          if (!redirectUri) {
            res.writeHead(400);
            res.end('missing redirect_uri');
            return;
          }
          // Hand the auth code back to the loopback redirect server the app
          // started in `run_loopback_flow`. Production opens this URL in
          // the system browser; the e2e harness short-circuits by issuing
          // an HTTP request directly to /auth and following the 302.
          const dest = `${redirectUri}?code=${state.authCode}&state=${stateParam}`;
          res.writeHead(302, { Location: dest });
          res.end();
          return;
        }

        // ── OAuth: token exchange ────────────────────────────────────────
        if (url.pathname === '/token') {
          await readBody(req); // drain
          // id_token is a base64url-encoded JSON payload (no signature
          // verification on the client side — see `extract_email_from_id_token`).
          const payload = Buffer.from(JSON.stringify({ email: 'alice@example.com' }))
            .toString('base64')
            .replace(/=+$/, '')
            .replace(/\+/g, '-')
            .replace(/\//g, '_');
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              access_token: 'access-1',
              refresh_token: 'refresh-1',
              expires_in: 3600,
              id_token: `eyJhbGciOiJIUzI1NiJ9.${payload}.sig`,
              token_type: 'Bearer',
            }),
          );
          return;
        }

        // ── files/{id}?alt=media (raw download) ──────────────────────────
        if (
          url.pathname.startsWith('/drive/v3/files/') &&
          url.searchParams.get('alt') === 'media'
        ) {
          const fileId = fileIdFromPath(url.pathname, 4);
          const f = fileId ? state.files.get(fileId) : undefined;
          if (!f) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, {
            etag: f.etag,
            'content-type': 'text/markdown',
          });
          res.end(f.body);
          return;
        }

        // ── upload/files/{id} (PATCH with If-Match) ──────────────────────
        if (url.pathname.startsWith('/upload/drive/v3/files/')) {
          const fileId = fileIdFromPath(url.pathname, 5);
          const f = fileId ? state.files.get(fileId) : undefined;
          if (!f) {
            res.writeHead(404);
            res.end();
            return;
          }
          const ifMatch = req.headers['if-match'];
          if (ifMatch !== f.etag) {
            res.writeHead(412, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ error: { code: 412, message: 'etag mismatch' } }),
            );
            return;
          }
          const body = await readBody(req);
          f.body = body;
          f.etag = `W/"${Date.now()}"`;
          res.writeHead(200, { etag: f.etag });
          res.end();
          return;
        }

        // ── files/{id}/comments (list + create) ──────────────────────────
        if (url.pathname.match(/^\/drive\/v3\/files\/[^/]+\/comments$/)) {
          const fileId = fileIdFromPath(url.pathname, 4);
          if (!fileId) {
            res.writeHead(404);
            res.end();
            return;
          }
          if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(
              JSON.stringify({ comments: state.comments.get(fileId) ?? [] }),
            );
            return;
          }
          if (req.method === 'POST') {
            const raw = await readBody(req);
            const parsed: { content?: string; quotedFileContent?: { value: string } } =
              raw ? JSON.parse(raw) : {};
            const id = `DID-${Math.random().toString(36).slice(2, 8)}`;
            const created: MockComment = {
              id,
              content: parsed.content ?? '',
              quotedFileContent: parsed.quotedFileContent,
              modifiedTime: new Date().toISOString(),
              resolved: false,
              replies: [],
              author: {
                displayName: 'Alice Anderson',
                emailAddress: 'alice@example.com',
              },
            };
            const list = state.comments.get(fileId) ?? [];
            list.push(created);
            state.comments.set(fileId, list);
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(JSON.stringify(created));
            return;
          }
        }

        // ── files/{id}/permissions ───────────────────────────────────────
        if (url.pathname.match(/^\/drive\/v3\/files\/[^/]+\/permissions$/)) {
          const fileId = fileIdFromPath(url.pathname, 4);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              permissions: (fileId && state.permissions.get(fileId)) ?? [],
            }),
          );
          return;
        }

        // ── files/{id} (metadata) ────────────────────────────────────────
        if (url.pathname.match(/^\/drive\/v3\/files\/[^/]+$/)) {
          const fileId = fileIdFromPath(url.pathname, 4);
          const f = fileId ? state.files.get(fileId) : undefined;
          if (!f) {
            res.writeHead(404);
            res.end();
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: fileId,
              name: f.name,
              modifiedTime: new Date().toISOString(),
              headRevisionId: 'r1',
              size: String(f.body.length),
            }),
          );
          return;
        }

        res.writeHead(404);
        res.end();
      } catch (e) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            error: { code: 500, message: (e as Error).message ?? 'mock failure' },
          }),
        );
      }
    })();
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${addr.port}`;

  return {
    base,
    authBase: `${base}/o/oauth2/v2/auth`,
    tokenBase: `${base}/token`,
    state,
    pushComment(fileId, content, quoted) {
      const id = `DID-${Math.random().toString(36).slice(2, 8)}`;
      const list = state.comments.get(fileId) ?? [];
      list.push({
        id,
        content,
        quotedFileContent: quoted ? { value: quoted } : undefined,
        modifiedTime: new Date().toISOString(),
        resolved: false,
        replies: [],
        author: {
          displayName: 'Bob Beam',
          emailAddress: 'bob@example.com',
        },
      });
      state.comments.set(fileId, list);
    },
    bumpEtag(fileId, newEtag) {
      const f = state.files.get(fileId);
      if (f) f.etag = newEtag;
    },
    setOffline(offline) {
      state.offline = offline;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
