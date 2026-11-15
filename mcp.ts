// mcp.ts — the Model Context Protocol endpoint at /mcp, JSON-RPC 2.0 over
// Streamable HTTP, answered as plain application/json. It speaks the modern
// revision 2026-07-28 (server/discover, no handshake, no session) and the legacy
// handshake era (initialize + notifications/initialized) so either client era
// connects. The tools act on the same store REST reads, with the same ids.

import { globalId, type Repo, type Store } from './store.ts';
import { VIEWER } from './scenario.ts';
import { computeMergeable } from './rest.ts';
import type { ReqCtx, Resp } from './rest.ts';
import { err, json } from './rest.ts';

const SERVER_NAME = 'github-core-clone-forge';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25'];

interface ToolDef {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        state: { type: 'string', description: 'open, closed or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function rpcResult(id: unknown, result: unknown): Resp {
  return json(200, { jsonrpc: '2.0', id: id ?? null, result });
}

function rpcError(id: unknown, code: number, message: string, data?: unknown): Resp {
  const error: Record<string, unknown> = { code, message };
  if (data !== undefined) error.data = data;
  return json(200, { jsonrpc: '2.0', id: id ?? null, error });
}

function toolText(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The nearest property name in a schema for a documented argument name. */
function mapArgs(tool: ToolDef, args: Record<string, unknown>): Record<string, unknown> {
  const props = Object.keys(tool.inputSchema.properties);
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (props.includes(key)) {
      out[key] = value;
      continue;
    }
    const match = props.find((p) => norm(p) === norm(key));
    if (match) out[match] = value;
    else out[key] = value;
  }
  // full_name fills owner/repo when they are missing.
  if (typeof out.full_name === 'string') {
    const [owner, repo] = out.full_name.split('/');
    if (owner && !out.owner) out.owner = owner;
    if (repo && !out.repo) out.repo = repo;
  }
  return out;
}

function findTool(name: string): ToolDef | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  const wanted = norm(name);
  return TOOLS.find((t) => norm(t.name) === wanted || norm(t.name).endsWith(wanted) || wanted.endsWith(norm(t.name)));
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repository', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
  };
}

export function handleMcp(store: Store, ctx: ReqCtx): Resp {
  if (ctx.method !== 'POST') return err(404, 'Not Found');
  const auth = ctx.headers.authorization ?? '';
  if (ctx.token === '') {
    if (!auth.startsWith('Bearer ') || auth.length <= 7) return err(401, 'Bad credentials');
  } else if (auth !== `Bearer ${ctx.token}`) {
    return err(401, 'Bad credentials');
  }
  let body: unknown;
  try {
    body = JSON.parse(ctx.body.toString('utf8'));
  } catch {
    return {
      status: 400,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }),
    };
  }
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return rpcError(null, -32600, 'Invalid Request');
  }
  const req = body as { jsonrpc?: string; id?: unknown; method?: string; params?: Record<string, unknown> };
  const id = req.id ?? null;
  const method = typeof req.method === 'string' ? req.method : '';
  const params = (req.params ?? {}) as Record<string, unknown>;

  // A notification (no id) is answered with 202 and no body.
  const isNotification = req.id === undefined;

  if (method === 'server/discover') {
    const result = {
      supportedVersions: SUPPORTED_VERSIONS,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: SERVER_NAME, version: SERVER_VERSION } },
    };
    return rpcResult(id, result);
  }

  if (method === 'initialize') {
    const offered = typeof params.protocolVersion === 'string' ? params.protocolVersion : '';
    const chosen = SUPPORTED_VERSIONS.includes(offered)
      ? offered
      : (params.protocolVersion === undefined ? '2025-11-25' : null);
    if (chosen === null) {
      return rpcError(id, -32022, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS });
    }
    return rpcResult(id, {
      protocolVersion: chosen,
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
  }

  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
  }

  if (method === 'ping') {
    return rpcResult(id, {});
  }

  if (method === 'tools/list') {
    if (isNotification) return { status: 202, contentType: 'application/json; charset=utf-8', body: '' };
    return rpcResult(id, { tools: TOOLS });
  }

  if (method === 'tools/call') {
    const name = String(params.name ?? '');
    const rawArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = findTool(name);
    if (!tool) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const args = mapArgs(tool, rawArgs);
    const missing = tool.inputSchema.required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
    if (missing.length > 0) {
      return rpcResult(id, toolError(`Missing required argument(s): ${missing.join(', ')}`));
    }
    const outcome = runTool(store, tool.name, args);
    if (outcome === null) return rpcError(id, -32602, `Unknown tool: ${name}`);
    return rpcResult(id, outcome);
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

/** Run one tool; returns its result object, or null when the name is unknown. */
function runTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const owner = String(args.owner ?? VIEWER.login);
  const repoName = String(args.repo ?? '');
  const repo = repoName === '' ? undefined : owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;

  if (name === 'create_repo') {
    const repoNameArg = String(args.name ?? '');
    if (repoNameArg === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoNameArg)) {
      return toolError('A valid repository name is required');
    }
    if (store.getRepo(VIEWER.login, repoNameArg)) return toolError('Repository already exists');
    const created = store.createRepo(repoNameArg, String(args.description ?? ''), args.private === true);
    return toolText(repoJson(created));
  }

  if (!repo) return toolError(`Repository ${owner}/${repoName} not found`);

  if (name === 'get_repo') return toolText(repoJson(repo));

  if (name === 'create_issue') {
    const title = String(args.title ?? '');
    if (title === '') return toolError('A title is required');
    const seq = store.tick();
    const issue = {
      number: repo.nextIssue++,
      title,
      body: String(args.body ?? ''),
      state: 'open' as const,
      labels: [],
      user: VIEWER.login,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return toolText({
      id: globalId('issue', repo.owner, repo.name, issue.number),
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    });
  }

  if (name === 'list_issues') {
    const state = String(args.state ?? 'open');
    let issues = [...repo.issues.values()];
    if (state !== 'all') issues = issues.filter((i) => i.state === state);
    issues.sort((a, b) => a.number - b.number);
    return toolText({
      issues: issues.map((i) => ({
        id: globalId('issue', repo.owner, repo.name, i.number),
        number: i.number,
        title: i.title,
        body: i.body,
        state: i.state,
      })),
    });
  }

  if (name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? '');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) return toolError('head or base branch does not exist');
    const pr = {
      number: repo.nextPull++,
      title: String(args.title ?? ''),
      body: String(args.body ?? ''),
      state: 'open' as const,
      merged: false,
      mergeable: true,
      headRef: head,
      baseRef: base,
      headSha: headTip,
      baseSha: baseTip,
      mergeCommitSha: null,
      mergedAtSeq: null,
      user: VIEWER.login,
      createdSeq: store.tick(),
      files: [],
    };
    repo.pulls.set(pr.number, pr);
    return toolText({
      id: globalId('pullrequest', repo.owner, repo.name, pr.number),
      number: pr.number,
      pull_number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      head: { ref: head, sha: headTip },
      base: { ref: base, sha: baseTip },
    });
  }

  if (name === 'merge_pull_request') {
    const number = Number(args.pull_number);
    const pr = repo.pulls.get(number);
    if (!pr) return toolError(`Pull request #${number} not found`);
    if (pr.state !== 'open') return toolError('Pull request is not open');
    if (!computeMergeable(store, repo, pr)) return toolError('Merge conflict');
    const headTree = store.commitTree(repo, pr.headSha);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? '0'.repeat(40);
    const ident = `${VIEWER.name} <${VIEWER.email}> 1700000000 +0000`;
    const commitData = Buffer.from(
      [`tree ${headTree}`, ...(baseTip === '0'.repeat(40) ? [] : [`parent ${baseTip}`]), `author ${ident}`, `committer ${ident}`, '', `Merge pull request #${pr.number} from ${pr.headRef}`].join('\n'),
      'utf8',
    );
    const mergeSha = store.putObject(repo, 'commit', commitData);
    repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
    pr.state = 'closed';
    pr.merged = true;
    pr.mergeCommitSha = mergeSha;
    pr.mergedAtSeq = store.tick();
    return toolText({ sha: mergeSha, merged: true, number: pr.number, state: pr.state });
  }

  return null;
}
