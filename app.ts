// app.ts — the forge's HTTP server: one process routing git smart HTTP,
// REST v3, GraphQL v4 and MCP over the shared store (store.ts).
//
// Auth model: the harness presents one bearer token (MAKEFUN_SHOP_TOKEN) that
// belongs to the scenario's viewer. A request with no Authorization header is
// refused 401 on the API surfaces; git endpoints accept the presented token
// as-is (the suite never challenges git auth, and a 401 there would fail the
// operation outright).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { gitRoute } from './githttp.ts';
import { handleRest, type RestResponse } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { ForgeError } from './store.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const MAX_BODY_BYTES = 64 * 1024 * 1024;

function requestId(): string {
  return randomBytes(8).toString('hex').toUpperCase();
}

function sendBuffer(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': body.length,
    'x-github-request-id': requestId(),
  });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendRest(res: ServerResponse, response: RestResponse): void {
  if (response.status === 204) {
    res.writeHead(204, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, response.status, response.body ?? {}, response.headers ?? {});
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) throw new ForgeError(413, 'Request body too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function isAuthed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  return typeof header === 'string' && header.trim() !== '';
}

export function createApp(): Server {
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const method = req.method ?? 'GET';

        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          const body = await readBody(req);
          const result = handleGraphQL(body.toString('utf8'), isAuthed(req));
          sendJson(res, result.status, result.body);
          return;
        }

        if (path === '/mcp') {
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const result = handleMcp(method, body.toString('utf8'), isAuthed(req));
          if (result.body === undefined) {
            res.writeHead(result.status, { 'x-github-request-id': requestId() });
            res.end();
            return;
          }
          sendJson(res, result.status, result.body);
          return;
        }

        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const body = await readBody(req);
          const response = handleRest({
            method,
            pathname: path,
            query: url.searchParams,
            bodyText: body.toString('utf8'),
            host: req.headers.host ?? 'localhost',
            authed: isAuthed(req),
          });
          sendRest(res, response);
          return;
        }

        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const [, ownerRaw, repoRaw, tailRaw] = gitMatch;
          const owner = decodeURIComponent(ownerRaw as string);
          const repoName = decodeURIComponent(repoRaw as string);
          const tail = tailRaw ?? '';
          const body = method === 'POST' ? await readBody(req) : Buffer.alloc(0);
          const result = gitRoute(owner, repoName, tail, method, url.searchParams, body, req.headers['git-protocol'] ?? null);
          sendBuffer(res, result.status, result.contentType, result.body);
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (err instanceof ForgeError) {
          sendJson(res, err.status, { message: err.message });
          return;
        }
        process.stderr.write(`[forge] unhandled error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
        if (!res.headersSent) sendJson(res, 500, { message: 'Internal Server Error' });
        else res.end();
      }
    })();
  });
  server.keepAliveTimeout = 75_000;
  server.headersTimeout = 80_000;
  return server;
}
