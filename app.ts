// app.ts — the forge's HTTP server: one process, one store, four surfaces.
// git smart HTTP at /{owner}/{repo}.git, REST v3 under /api/v3, GraphQL at
// /api/graphql and MCP at /mcp. Every reply carries X-GitHub-Request-Id and is
// JSON except the git wire itself, which is pkt-lined. A handler that throws
// answers 500 JSON and never takes the server down with it.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import {
  advertisementV0Receive,
  advertisementV0Upload,
  advertisementV2,
  advertisedRefs,
  applyPush,
  decodePktLines,
  fetchResponseV0,
  fetchResponseV2,
  lsRefsResponse,
  parsePushBody,
  parseV2Request,
  planFetch,
  pushReportResponse,
  readPack,
  type FetchRequest,
} from './git.ts';
import { handleRest, type ReqCtx } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 64 * 1024 * 1024;

let requestCounter = 0;

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}

function headersOf(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (typeof value === 'string') out[key.toLowerCase()] = value;
  }
  return out;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

interface Reply {
  status: number;
  contentType: string;
  body: Buffer;
  headers?: Record<string, string>;
}

function send(res: ServerResponse, reply: Reply): void {
  const id = `req-${++requestCounter}`;
  res.writeHead(reply.status, {
    'content-type': reply.contentType,
    'content-length': reply.body.length,
    'x-github-request-id': id,
    ...(reply.headers ?? {}),
  });
  res.end(reply.body);
}

function sendJson(res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  send(res, { status, contentType: 'application/json; charset=utf-8', body: Buffer.from(`${JSON.stringify(value)}\n`, 'utf8'), headers });
}

function sendRest(res: ServerResponse, r: { status: number; contentType: string; body: string; headers?: Record<string, string> }): void {
  send(res, { status: r.status, contentType: r.contentType, body: Buffer.from(r.body, 'utf8'), headers: r.headers });
}

/** Parse a v0 upload-pack request body into a fetch request. */
function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  let done = false;
  let section = 0;
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      section += 1;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    const [head, ...rest] = line.split(' ');
    if (head === 'want' && rest.length > 0) wants.push(rest[0]);
    else if (head === 'have' && rest.length > 0) haves.push(rest[0]);
    else if (head === 'shallow' && rest.length > 0) shallow.push(rest[0]);
    else if (head === 'deepen' && rest.length > 0) depth = Number(rest[0]);
    else if (head === 'deepen-since' && rest.length > 0) deepenSince = Number(rest[0]);
    else if (head === 'deepen-not' && rest.length > 0) deepenNot.push(rest[0]);
    else if (line === 'done') done = true;
    void section;
  }
  return { wants, haves, shallow, depth, deepenSince, deepenNot, done };
}

export function createApp(): Server {
  const store = new Store();
  const token = process.env.MAKEFUN_SHOP_TOKEN ?? '';

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const method = req.method ?? 'GET';
      const path = pathOf(req);
      const query = queryOf(req);
      const headers = headersOf(req);
      const host = headers.host ?? '127.0.0.1';
      let body = Buffer.alloc(0);
      if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        try {
          body = await readBody(req);
        } catch {
          sendJson(res, 400, { message: 'Request body too large' });
          return;
        }
      }

      try {
        // The env's boot probe: 200 {"ok":true}, no token needed.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        const ctx: ReqCtx = { method, path, query, headers, body, host, token };

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const r = handleRest(store, ctx);
          if (r) {
            sendRest(res, r);
            return;
          }
        }

        // GraphQL v4.
        if (path === '/api/graphql') {
          sendRest(res, handleGraphQL(store, ctx));
          return;
        }

        // MCP.
        if (path === '/mcp') {
          if (method === 'DELETE') {
            sendJson(res, 200, {});
            return;
          }
          sendRest(res, handleMcp(store, ctx));
          return;
        }

        // Git smart HTTP.
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git\/(.*)$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]);
          const repoName = decodeURIComponent(gitMatch[2]);
          const tail = gitMatch[3];
          const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
          if (!repo) {
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'GET' && tail === 'info/refs') {
            const service = query.get('service');
            if (service === 'git-upload-pack') {
              if (headers['git-protocol'] === 'version=2') {
                send(res, { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV2() });
              } else {
                send(res, { status: 200, contentType: 'application/x-git-upload-pack-advertisement', body: advertisementV0Upload(repo) });
              }
              return;
            }
            if (service === 'git-receive-pack') {
              send(res, { status: 200, contentType: 'application/x-git-receive-pack-advertisement', body: advertisementV0Receive(repo) });
              return;
            }
            sendJson(res, 404, { message: 'Not Found' });
            return;
          }
          if (method === 'POST' && tail === 'git-upload-pack') {
            if (headers['git-protocol'] === 'version=2') {
              let parsed;
              try {
                parsed = parseV2Request(body);
              } catch {
                sendJson(res, 400, { message: 'Malformed pkt-line stream' });
                return;
              }
              if (parsed.command === 'ls-refs') {
                const prefixes = parsed.args.get('ref-prefix') ?? [];
                send(res, { status: 200, contentType: 'application/x-git-upload-pack-result', body: lsRefsResponse(advertisedRefs(repo), prefixes) });
                return;
              }
              if (parsed.command === 'fetch') {
                const args = parsed.args;
                const req: FetchRequest = {
                  wants: args.get('want') ?? [],
                  haves: args.get('have') ?? [],
                  shallow: args.get('shallow') ?? [],
                  depth: args.get('deepen')?.[0] !== undefined ? Number(args.get('deepen')![0]) : undefined,
                  deepenSince: args.get('deepen-since')?.[0] !== undefined ? Number(args.get('deepen-since')![0]) : undefined,
                  deepenNot: args.get('deepen-not') ?? [],
                  done: args.has('done'),
                  filter: args.get('filter')?.[0],
                };
                const plan = planFetch(store, repo, req.wants, req.haves, req.shallow, req.depth);
                send(res, { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV2(plan) });
                return;
              }
              sendJson(res, 400, { message: `Unknown upload-pack command ${parsed.command}` });
              return;
            }
            // Protocol v0 fetch.
            let v0: FetchRequest;
            try {
              v0 = parseV0Fetch(body);
            } catch {
              sendJson(res, 400, { message: 'Malformed pkt-line stream' });
              return;
            }
            const plan = planFetch(store, repo, v0.wants, v0.haves, v0.shallow, v0.depth);
            send(res, { status: 200, contentType: 'application/x-git-upload-pack-result', body: fetchResponseV0(plan) });
            return;
          }
          if (method === 'POST' && tail === 'git-receive-pack') {
            let commands;
            let pack: Buffer;
            try {
              const parsed = parsePushBody(body);
              commands = parsed.commands;
              pack = parsed.pack;
            } catch {
              sendJson(res, 400, { message: 'Malformed push stream' });
              return;
            }
            let unpackOk = true;
            if (pack.length > 0) {
              try {
                const objects = readPack(pack, (oid) => store.getObject(repo, oid));
                for (const [oid, object] of objects) {
                  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
                }
              } catch {
                unpackOk = false;
              }
            }
            if (!unpackOk) {
              // report-status with a failed unpack line; the client reads unpackOk=false.
              send(res, {
                status: 200,
                contentType: 'application/x-git-receive-pack-result',
                body: pushReportResponse([], false),
              });
              return;
            }
            const { lines } = applyPush(store, repo, commands);
            send(res, { status: 200, contentType: 'application/x-git-receive-pack-result', body: pushReportResponse(lines) });
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        sendJson(res, 404, { message: 'Not Found' });
      } catch (e) {
        // A handler that throws must not take the server down: answer 500 JSON.
        try {
          sendJson(res, 500, { message: e instanceof Error ? e.message : 'Internal error' });
        } catch {
          // The socket is already gone; nothing more to do.
        }
      }
    })();
  });
}
