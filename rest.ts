// rest.ts — the GitHub REST v3 API under /api/v3. Repositories, branches, commits,
// contents, labels, issues, comments and pull requests, all over the one in-memory
// store. Statuses and shapes follow the suite's contract exactly; every reply is
// JSON with a non-empty X-GitHub-Request-Id, and an error body is {message}.

import {
  buildCommit,
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  SERVER_EPOCH,
  serverIdent,
  ZERO_OID,
  globalId,
  type Issue,
  type Label,
  type PullFile,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';

export interface ReqCtx {
  method: string;
  path: string;
  query: URLSearchParams;
  headers: Record<string, string>;
  body: Buffer;
  host: string;
  /** The bearer token this trial's env issued ('' when the env set none). */
  token: string;
}

export interface Resp {
  status: number;
  contentType: string;
  body: string;
  headers?: Record<string, string>;
}

export function json(status: number, value: unknown, headers: Record<string, string> = {}): Resp {
  return { status, contentType: 'application/json; charset=utf-8', body: `${JSON.stringify(value)}\n`, headers };
}

export function err(status: number, message: string): Resp {
  return json(status, { message });
}

/** A fixed ISO date: the forge keeps no wall clock in its answers. */
function isoDate(seq: number): string {
  return new Date((SERVER_EPOCH + seq) * 1000).toISOString();
}

function userJson(login: string): Record<string, unknown> {
  return { login, id: login === VIEWER.login ? VIEWER.id : 0, node_id: globalId('user', login, ''), type: 'User', site_admin: false };
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('repository', repo.owner, repo.name),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(repo.owner),
    private: repo.private,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: isoDate(repo.createdSeq),
    updated_at: isoDate(repo.createdSeq),
    pushed_at: isoDate(repo.createdSeq),
    default_branch: repo.defaultBranch,
  };
}

function labelJson(label: Label, repo: Repo): Record<string, unknown> {
  return {
    id: label.id,
    node_id: globalId('label', repo.owner, repo.name, label.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    name: label.name,
    color: label.color,
    description: label.description,
    default: false,
  };
}

function issueJson(issue: Issue, repo: Repo): Record<string, unknown> {
  return {
    id: repo.id * 10000 + issue.number,
    node_id: globalId('issue', repo.owner, repo.name, issue.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    user: userJson(issue.user),
    labels: issue.labels.map((l) => labelJson(l, repo)),
    assignee: null,
    locked: false,
    comments: issue.comments.length,
    created_at: isoDate(issue.createdSeq),
    updated_at: isoDate(issue.updatedSeq),
    closed_at: issue.state === 'closed' ? isoDate(issue.updatedSeq) : null,
  };
}

function prJson(pr: PullRequest, repo: Repo, store: Store): Record<string, unknown> {
  const headSha = store.refTip(repo, `refs/heads/${pr.headRef}`);
  const baseSha = store.refTip(repo, `refs/heads/${pr.baseRef}`);
  return {
    id: repo.id * 10000 + pr.number,
    node_id: globalId('pullrequest', repo.owner, repo.name, pr.number),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    merged: pr.merged,
    mergeable: computeMergeable(store, repo, pr),
    merge_commit_sha: pr.mergeCommitSha,
    merged_at: pr.mergedAtSeq === null ? null : isoDate(pr.mergedAtSeq),
    user: userJson(pr.user),
    head: { label: `${repo.owner}:${pr.headRef}`, ref: pr.headRef, sha: headSha === ZERO_OID ? pr.headSha : headSha },
    base: { label: `${repo.owner}:${pr.baseRef}`, ref: pr.baseRef, sha: baseSha === ZERO_OID ? pr.baseSha : baseSha },
    created_at: isoDate(pr.createdSeq),
    updated_at: isoDate(pr.createdSeq),
  };
}

// -------------------------------------------------------------------------------------------
// trees and commits for the contents API
// -------------------------------------------------------------------------------------------

/** The tree at a commit, or the empty tree when the ref is unborn. */
function treeAt(store: Store, repo: Repo, commitOid: string): string {
  if (commitOid === ZERO_OID) return store.putObject(repo, 'tree', buildTree([]));
  const object = repo.objects.get(commitOid);
  if (!object || object.type !== 'commit') return store.putObject(repo, 'tree', buildTree([]));
  return parseCommit(object.data).tree;
}

/** Set `path` to `blobOid` in the tree `treeOid`, creating intermediate trees. */
function setPath(store: Store, repo: Repo, treeOid: string, parts: string[], blobOid: string, mode: string): string {
  const object = repo.objects.get(treeOid);
  const entries = object?.type === 'tree' ? parseTree(object.data) : [];
  const [head, ...tail] = parts;
  const next = entries.filter((e) => e.name !== head);
  if (tail.length === 0) {
    next.push({ mode, name: head, oid: blobOid });
  } else {
    const child = entries.find((e) => e.name === head && e.mode === '40000');
    const childTree = child ? setPath(store, repo, child.oid, tail, blobOid, mode) : setPath(store, repo, store.putObject(repo, 'tree', buildTree([])), tail, blobOid, mode);
    next.push({ mode: '40000', name: head, oid: childTree });
  }
  return store.putObject(repo, 'tree', buildTree(next));
}

/** Remove `path` from the tree `treeOid`; returns the new tree oid ('' when absent). */
function removePath(store: Store, repo: Repo, treeOid: string, parts: string[]): string {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return treeOid;
  const entries = parseTree(object.data);
  const [head, ...tail] = parts;
  const target = entries.find((e) => e.name === head);
  if (!target) return treeOid;
  if (tail.length === 0) {
    return store.putObject(repo, 'tree', buildTree(entries.filter((e) => e.name !== head)));
  }
  if (target.mode !== '40000') return treeOid;
  const child = removePath(store, repo, target.oid, tail);
  const next = entries.map((e) => (e.name === head ? { ...e, oid: child } : e));
  return store.putObject(repo, 'tree', buildTree(next));
}

/** Look a path up in a tree: the entry and, for a directory, its tree oid. */
function lookupPath(store: Store, repo: Repo, treeOid: string, parts: string[]): { oid: string; mode: string } | null {
  let current = treeOid;
  for (let i = 0; i < parts.length; i += 1) {
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) return { oid: entry.oid, mode: entry.mode };
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

/** A line-multiset diff: additions/deletions between two blob texts. */
function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.split('\n')) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const oldLines = count(oldText);
  const newLines = count(newText);
  let additions = 0;
  let deletions = 0;
  for (const [line, n] of newLines) additions += Math.max(0, n - (oldLines.get(line) ?? 0));
  for (const [line, n] of oldLines) deletions += Math.max(0, n - (newLines.get(line) ?? 0));
  return { additions, deletions };
}

/** The files a pull changes: merge-base tree vs head tree, with line counts. */
export function computePullFiles(store: Store, repo: Repo, pr: PullRequest): PullFile[] {
  const baseTip = store.refTip(repo, `refs/heads/${pr.baseRef}`);
  const base = store.mergeBase(repo, pr.headSha, baseTip === ZERO_OID ? pr.baseSha : baseTip) ?? pr.baseSha;
  const baseTree = store.flatTree(repo, store.commitTree(repo, base));
  const headTree = store.flatTree(repo, store.commitTree(repo, pr.headSha));
  const files: PullFile[] = [];
  const paths = new Set([...baseTree.keys(), ...headTree.keys()]);
  for (const path of [...paths].sort()) {
    const before = baseTree.get(path);
    const after = headTree.get(path);
    if (before && after && before.oid === after.oid) continue;
    if (before && !after) {
      const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff(oldText, '');
      files.push({ filename: path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
    } else if (!before && after) {
      const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff('', newText);
      files.push({ filename: path, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
    } else if (before && after) {
      const oldText = repo.objects.get(before.oid)?.data.toString('utf8') ?? '';
      const newText = repo.objects.get(after.oid)?.data.toString('utf8') ?? '';
      const diff = lineDiff(oldText, newText);
      files.push({ filename: path, status: 'modified', additions: diff.additions, deletions: diff.deletions, changes: diff.additions + diff.deletions });
    }
  }
  return files;
}

/** True when the pull can merge cleanly: no path changed differently on both sides. */
export function computeMergeable(store: Store, repo: Repo, pr: PullRequest): boolean {
  if (pr.state !== 'open') return false;
  // The base is the branch's CURRENT tip, not the tip at creation: a sibling
  // pull merged since then moves the base, and that is what conflicts.
  const baseTip = store.refTip(repo, `refs/heads/${pr.baseRef}`);
  const baseRef = baseTip === ZERO_OID ? pr.baseSha : baseTip;
  const base = store.mergeBase(repo, pr.headSha, baseRef);
  if (base === null) return pr.headSha !== baseRef;
  const baseTree = store.flatTree(repo, store.commitTree(repo, base));
  const headTree = store.flatTree(repo, store.commitTree(repo, pr.headSha));
  const destTree = store.flatTree(repo, store.commitTree(repo, baseRef));
  const paths = new Set([...headTree.keys(), ...destTree.keys()]);
  for (const path of paths) {
    const b = baseTree.get(path)?.oid;
    const h = headTree.get(path)?.oid;
    const d = destTree.get(path)?.oid;
    const headChanged = h !== b;
    const destChanged = d !== b;
    if (headChanged && destChanged && h !== d) return false;
  }
  return true;
}

// -------------------------------------------------------------------------------------------
// pagination
// -------------------------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, Number(query.get('page') ?? '1') || 1);
  const perPage = Math.min(100, Math.max(1, Number(query.get('per_page') ?? '30') || 30));
  return { page, perPage };
}

function paginate<T>(items: T[], ctx: ReqCtx, total: number): { page: T[]; headers: Record<string, string> } {
  const { page, perPage } = pageParams(ctx.query);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages > 1) {
    const base = `http://${ctx.host}${ctx.path}`;
    const links: string[] = [];
    const q = new URLSearchParams(ctx.query);
    const link = (p: number, rel: string): string => {
      q.set('page', String(p));
      q.set('per_page', String(perPage));
      return `<${base}?${q.toString()}>; rel="${rel}"`;
    };
    if (page < totalPages) links.push(link(page + 1, 'next'));
    if (page > 1) links.push(link(page - 1, 'prev'));
    links.push(link(1, 'first'));
    links.push(link(totalPages, 'last'));
    headers.link = links.join(', ');
  }
  return { page: slice, headers };
}

// -------------------------------------------------------------------------------------------
// auth and body parsing
// -------------------------------------------------------------------------------------------

export function authed(ctx: ReqCtx): boolean {
  const header = ctx.headers.authorization ?? '';
  if (ctx.token === '') return header.startsWith('Bearer ') && header.length > 7;
  return header === `Bearer ${ctx.token}`;
}

export function parseJsonBody(ctx: ReqCtx): { ok: true; value: Record<string, unknown> } | { ok: false; resp: Resp } {
  if (ctx.body.length === 0) return { ok: true, value: {} };
  try {
    const value = JSON.parse(ctx.body.toString('utf8')) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { ok: false, resp: err(400, 'Invalid JSON body') };
    }
    return { ok: true, value: value as Record<string, unknown> };
  } catch {
    return { ok: false, resp: err(400, 'Invalid JSON body') };
  }
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

// -------------------------------------------------------------------------------------------
// the dispatcher
// -------------------------------------------------------------------------------------------

/** Route one /api/v3 request. Returns null when the path is not an /api/v3 route. */
export function handleRest(store: Store, ctx: ReqCtx): Resp | null {
  const { method, path } = ctx;
  if (!path.startsWith('/api/v3')) return null;
  const rest = path.slice('/api/v3'.length);

  if (!authed(ctx)) return err(401, 'Bad credentials');

  // API root and meta.
  if (method === 'GET' && (rest === '' || rest === '/')) {
    return json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
  }
  if (method === 'GET' && rest === '/meta') {
    return json(200, { installed_version: '1.0.0' });
  }

  // The authenticated user and their repositories.
  if (rest === '/user' && method === 'GET') {
    return json(200, {
      login: VIEWER.login,
      id: VIEWER.id,
      node_id: globalId('user', VIEWER.login, ''),
      avatar_url: '',
      html_url: `https://github.com/${VIEWER.login}`,
      type: 'User',
      name: VIEWER.name,
      email: VIEWER.email,
    });
  }
  if (rest === '/user/repos') {
    if (method === 'GET') {
      const repos = store.viewerRepos();
      const { page, headers } = paginate(repos, ctx, repos.length);
      return json(200, page.map(repoJson), headers);
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.resp;
      const name = str(parsed.value.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) return err(422, 'Invalid repository name');
      if (store.getRepo(VIEWER.login, name)) return err(422, 'Repository already exists');
      const repo = store.createRepo(name, str(parsed.value.description), parsed.value.private !== false);
      return json(201, repoJson(repo));
    }
    return err(404, 'Not Found');
  }

  // /repos/{owner}/{name}[/...]
  const repoMatch = /^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/.exec(rest);
  if (!repoMatch) return err(404, 'Not Found');
  const owner = decodeURIComponent(repoMatch[1]);
  const repoName = decodeURIComponent(repoMatch[2]);
  const tail = repoMatch[3] ?? '';
  const repo = owner === VIEWER.login ? store.getRepo(owner, repoName) : undefined;
  if (!repo) return err(404, 'Not Found');

  if (tail === '' || tail === '/') {
    if (method === 'GET') return json(200, repoJson(repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.resp;
      if (typeof parsed.value.description === 'string') repo.description = parsed.value.description;
      if (typeof parsed.value.private === 'boolean') repo.private = parsed.value.private;
      return json(200, repoJson(repo));
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
    }
    return err(404, 'Not Found');
  }

  // Branches.
  if (tail === '/branches' && method === 'GET') {
    const list = [...repo.refs.keys()]
      .filter((r) => r.startsWith('refs/heads/'))
      .sort()
      .map((ref) => ({
        name: ref.slice('refs/heads/'.length),
        commit: { sha: repo.refs.get(ref), url: `/api/v3/repos/${owner}/${repoName}/commits/${repo.refs.get(ref)}` },
        protected: false,
      }));
    return json(200, list);
  }
  const branchMatch = /^\/branches\/(.+)$/.exec(tail);
  if (branchMatch && method === 'GET') {
    const branch = decodeURIComponent(branchMatch[1]);
    const tip = repo.refs.get(`refs/heads/${branch}`);
    if (!tip) return err(404, 'Not Found');
    return json(200, { name: branch, commit: { sha: tip, url: `/api/v3/repos/${owner}/${repoName}/commits/${tip}` }, protected: false });
  }

  // Commits.
  if (tail === '/commits' && method === 'GET') {
    const ref = ctx.query.get('sha') ?? repo.defaultBranch;
    const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined) ?? ZERO_OID;
    const commits: Record<string, unknown>[] = [];
    const seen = store.reachableCommits(repo, [tip]);
    // Walk first-parent order from the tip for a stable, newest-first list.
    const order: string[] = [];
    let current = tip;
    const guard = new Set<string>();
    while (current && current !== ZERO_OID && !guard.has(current) && seen.has(current)) {
      guard.add(current);
      order.push(current);
      const object = repo.objects.get(current);
      if (!object || object.type !== 'commit') break;
      current = parseCommit(object.data).parents[0] ?? ZERO_OID;
    }
    for (const oid of order) {
      const object = repo.objects.get(oid)!;
      const view = parseCommit(object.data);
      commits.push({
        sha: oid,
        commit: {
          message: view.message,
          author: { name: view.author.split(' <')[0], email: '', date: isoDate(0) },
          committer: { name: view.committer.split(' <')[0], email: '', date: isoDate(0) },
        },
        parents: view.parents.map((p) => ({ sha: p })),
        url: `/api/v3/repos/${owner}/${repoName}/commits/${oid}`,
        html_url: `https://github.com/${owner}/${repoName}/commit/${oid}`,
      });
    }
    const { page, headers } = paginate(commits, ctx, commits.length);
    return json(200, page, headers);
  }
  const commitMatch = /^\/commits\/([0-9a-f]{40})$/.exec(tail);
  if (commitMatch && method === 'GET') {
    const object = repo.objects.get(commitMatch[1]);
    if (!object || object.type !== 'commit') return err(404, 'Not Found');
    const view = parseCommit(object.data);
    return json(200, {
      sha: commitMatch[1],
      commit: { message: view.message, author: { name: view.author.split(' <')[0], email: '', date: isoDate(0) }, committer: { name: view.committer.split(' <')[0], email: '', date: isoDate(0) } },
      parents: view.parents.map((p) => ({ sha: p })),
    });
  }

  // Git refs.
  if (tail === '/git/refs' && method === 'POST') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return parsed.resp;
    const ref = str(parsed.value.ref);
    const sha = str(parsed.value.sha);
    if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) return err(422, 'Invalid ref or sha');
    if (repo.refs.has(ref)) return err(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: repo.objects.get(sha)!.type, url: `/api/v3/repos/${owner}/${repoName}/git/refs/${ref}` } });
  }
  if (tail === '/git/refs' && method === 'GET') {
    const list = [...repo.refs.keys()].sort().map((ref) => ({ ref, object: { sha: repo.refs.get(ref), type: 'commit', url: '' } }));
    return json(200, list);
  }
  const refMatch = /^\/git\/refs\/(.+)$/.exec(tail);
  if (refMatch && method === 'GET') {
    const ref = decodeURIComponent(refMatch[1]);
    const tip = repo.refs.get(ref);
    if (!tip) return err(404, 'Not Found');
    return json(200, { ref, object: { sha: tip, type: repo.objects.get(tip)?.type ?? 'commit', url: '' } });
  }
  if (refMatch && method === 'DELETE') {
    const ref = decodeURIComponent(refMatch[1]);
    if (!repo.refs.has(ref)) return err(404, 'Not Found');
    repo.refs.delete(ref);
    return { status: 204, contentType: 'application/json; charset=utf-8', body: '' };
  }

  // Contents.
  const contentsMatch = /^\/contents(\/(.*))?$/.exec(tail);
  if (contentsMatch) {
    return handleContents(store, repo, ctx, contentsMatch[2] ?? '');
  }

  // Labels.
  if (tail === '/labels') {
    if (method === 'GET') return json(200, [...repo.labels.values()].map((l) => labelJson(l, repo)));
    if (method === 'POST') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.resp;
      const name = str(parsed.value.name);
      if (name === '') return err(422, 'Label name is required');
      if (repo.labels.has(name)) return err(422, 'Label already exists');
      const label: Label = {
        id: store.nextLabelId++,
        name,
        color: str(parsed.value.color, 'ededed').replace(/^#/, ''),
        description: str(parsed.value.description),
      };
      repo.labels.set(name, label);
      return json(201, labelJson(label, repo));
    }
    return err(404, 'Not Found');
  }

  // Issues.
  if (tail === '/issues') {
    if (method === 'GET') return listIssues(repo, ctx);
    if (method === 'POST') return createIssue(store, repo, ctx);
    return err(404, 'Not Found');
  }
  const issueMatch = /^\/issues\/(\d+)(\/comments)?$/.exec(tail);
  if (issueMatch) {
    const number = Number(issueMatch[1]);
    const issue = repo.issues.get(number);
    if (!issue) return err(404, 'Not Found');
    if (issueMatch[2] === '/comments') {
      if (method === 'GET') {
        return json(200, issue.comments.map((c) => ({
          id: c.id,
          node_id: globalId('comment', owner, repoName, c.id),
          body: c.body,
          user: userJson(c.user),
          created_at: isoDate(c.createdSeq),
          updated_at: isoDate(c.createdSeq),
          html_url: `https://github.com/${owner}/${repoName}/issues/${number}#issuecomment-${c.id}`,
          url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${c.id}`,
        })));
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(ctx);
        if (!parsed.ok) return parsed.resp;
        const comment = { id: repo.nextCommentId++, body: str(parsed.value.body), user: VIEWER.login, createdSeq: store.tick() };
        issue.comments.push(comment);
        issue.updatedSeq = store.tick();
        return json(201, {
          id: comment.id,
          node_id: globalId('comment', owner, repoName, comment.id),
          body: comment.body,
          user: userJson(comment.user),
          created_at: isoDate(comment.createdSeq),
          updated_at: isoDate(comment.createdSeq),
          html_url: `https://github.com/${owner}/${repoName}/issues/${number}#issuecomment-${comment.id}`,
          url: `/api/v3/repos/${owner}/${repoName}/issues/comments/${comment.id}`,
        });
      }
      return err(404, 'Not Found');
    }
    if (method === 'GET') return json(200, issueJson(issue, repo));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.resp;
      if (typeof parsed.value.title === 'string') issue.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') issue.body = parsed.value.body;
      if (parsed.value.state === 'open' || parsed.value.state === 'closed') issue.state = parsed.value.state;
      issue.updatedSeq = store.tick();
      return json(200, issueJson(issue, repo));
    }
    return err(404, 'Not Found');
  }

  // Pull requests.
  if (tail === '/pulls') {
    if (method === 'GET') return listPulls(store, repo, ctx);
    if (method === 'POST') return createPull(store, repo, ctx);
    return err(404, 'Not Found');
  }
  const pullFilesMatch = /^\/pulls\/(\d+)\/files$/.exec(tail);
  if (pullFilesMatch && method === 'GET') {
    const pr = repo.pulls.get(Number(pullFilesMatch[1]));
    if (!pr) return err(404, 'Not Found');
    const files = computePullFiles(store, repo, pr);
    return json(200, files.map((f) => ({ ...f, sha: '', blob_url: '', raw_url: '', patch: '' })));
  }
  const pullMergeMatch = /^\/pulls\/(\d+)\/merge$/.exec(tail);
  if (pullMergeMatch && method === 'PUT') return mergePull(store, repo, ctx, Number(pullMergeMatch[1]));
  const pullMatch = /^\/pulls\/(\d+)$/.exec(tail);
  if (pullMatch) {
    const pr = repo.pulls.get(Number(pullMatch[1]));
    if (!pr) return err(404, 'Not Found');
    if (method === 'GET') return json(200, prJson(pr, repo, store));
    if (method === 'PATCH') {
      const parsed = parseJsonBody(ctx);
      if (!parsed.ok) return parsed.resp;
      if (typeof parsed.value.title === 'string') pr.title = parsed.value.title;
      if (typeof parsed.value.body === 'string') pr.body = parsed.value.body;
      if (parsed.value.state === 'closed') pr.state = 'closed';
      return json(200, prJson(pr, repo, store));
    }
    return err(404, 'Not Found');
  }

  return err(404, 'Not Found');
}

// -------------------------------------------------------------------------------------------
// contents
// -------------------------------------------------------------------------------------------

function handleContents(store: Store, repo: Repo, ctx: ReqCtx, rawPath: string): Resp {
  const decodedPath = rawPath.split('/').map((p) => decodeURIComponent(p)).join('/');
  const parts = decodedPath === '' ? [] : decodedPath.split('/').filter((p) => p !== '');
  // The branch comes from the JSON body's `branch` (contents writes) or ?ref= (reads).
  let bodyBranch = '';
  if (ctx.method === 'PUT' || ctx.method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return parsed.resp;
    bodyBranch = str(parsed.value.branch);
  }
  const branch = bodyBranch !== '' ? bodyBranch : ctx.query.get('ref') || repo.defaultBranch;
  const refName = `refs/heads/${branch}`;
  const tip = repo.refs.get(refName) ?? ZERO_OID;

  if (ctx.method === 'GET') {
    if (tip === ZERO_OID && parts.length > 0) return err(404, 'Not Found');
    const tree = treeAt(store, repo, tip);
    if (parts.length === 0) {
      return json(200, dirListing(store, repo, tree, ''));
    }
    const found = lookupPath(store, repo, tree, parts);
    if (!found) return err(404, 'Not Found');
    if (found.mode === '40000') return json(200, dirListing(store, repo, found.oid, decodedPath));
    const blob = repo.objects.get(found.oid);
    if (!blob || blob.type !== 'blob') return err(404, 'Not Found');
    return json(200, {
      type: 'file',
      encoding: 'base64',
      size: blob.data.length,
      name: parts[parts.length - 1],
      path: decodedPath,
      content: blob.data.toString('base64'),
      sha: found.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${decodedPath}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/blob/${branch}/${decodedPath}`,
    });
  }

  if (ctx.method === 'PUT') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return parsed.resp;
    const message = str(parsed.value.message, 'Update file');
    const contentB64 = str(parsed.value.content);
    if (contentB64 === '') return err(422, 'Content is required');
    let content: Buffer;
    try {
      content = Buffer.from(contentB64.replace(/[\r\n\t ]+/g, ''), 'base64');
    } catch {
      return err(422, 'Content is not valid base64');
    }
    const sha = str(parsed.value.sha);
    const tree = treeAt(store, repo, tip);
    const existing = parts.length === 0 ? null : lookupPath(store, repo, tree, parts);
    if (sha !== '') {
      if (!existing || existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
    } else if (existing) {
      return err(422, 'File already exists');
    }
    const blobOid = store.putObject(repo, 'blob', content);
    const newTree = setPath(store, repo, tree, parts, blobOid, '100644');
    const ident = serverIdent();
    const commitData = buildCommit(newTree, tip === ZERO_OID ? [] : [tip], ident, ident, message);
    const commitOid = store.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitOid);
    const status = existing ? 200 : 201;
    return json(status, {
      content: {
        name: parts[parts.length - 1],
        path: decodedPath,
        sha: blobOid,
        size: content.length,
        type: 'file',
        encoding: 'base64',
        url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${decodedPath}`,
      },
      commit: { sha: commitOid, message },
    });
  }

  if (ctx.method === 'DELETE') {
    const parsed = parseJsonBody(ctx);
    if (!parsed.ok) return parsed.resp;
    const message = str(parsed.value.message, 'Delete file');
    const sha = str(parsed.value.sha);
    const tree = treeAt(store, repo, tip);
    const existing = lookupPath(store, repo, tree, parts);
    if (!existing) return err(404, 'Not Found');
    if (sha !== '' && existing.oid !== sha) return err(409, 'Conflict: sha does not match the current file');
    const newTree = removePath(store, repo, tree, parts);
    const ident = serverIdent();
    const commitData = buildCommit(newTree, tip === ZERO_OID ? [] : [tip], ident, ident, message);
    const commitOid = store.putObject(repo, 'commit', commitData);
    repo.refs.set(refName, commitOid);
    return json(200, { commit: { sha: commitOid, message } });
  }

  return err(404, 'Not Found');
}

function dirListing(store: Store, repo: Repo, treeOid: string, base: string): Record<string, unknown>[] {
  const object = repo.objects.get(treeOid);
  if (!object || object.type !== 'tree') return [];
  return parseTree(object.data).map((entry) => {
    const isDir = entry.mode === '40000';
    const blob = isDir ? undefined : repo.objects.get(entry.oid);
    return {
      type: isDir ? 'dir' : 'file',
      size: isDir ? 0 : (blob?.data.length ?? 0),
      name: entry.name,
      path: base === '' ? entry.name : `${base}/${entry.name}`,
      sha: entry.oid,
      url: `/api/v3/repos/${repo.owner}/${repo.name}/contents/${base === '' ? entry.name : `${base}/${entry.name}`}`,
      html_url: `https://github.com/${repo.owner}/${repo.name}/tree/${repo.defaultBranch}/${base === '' ? entry.name : `${base}/${entry.name}`}`,
    };
  });
}

// -------------------------------------------------------------------------------------------
// issues and pulls
// -------------------------------------------------------------------------------------------

function listIssues(repo: Repo, ctx: ReqCtx): Resp {
  const state = ctx.query.get('state') ?? 'open';
  const sort = ctx.query.get('sort') ?? 'created';
  const direction = ctx.query.get('direction') ?? 'desc';
  let issues = [...repo.issues.values()];
  if (state !== 'all') issues = issues.filter((i) => i.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
  }
  const { page, headers } = paginate(issues, ctx, issues.length);
  return json(200, page.map((i) => issueJson(i, repo)), headers);
}

function createIssue(store: Store, repo: Repo, ctx: ReqCtx): Resp {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.resp;
  const title = str(parsed.value.title);
  if (title === '') return err(422, 'Title is required');
  const labels: Label[] = [];
  const labelNames = Array.isArray(parsed.value.labels) ? parsed.value.labels : [];
  for (const name of labelNames) {
    if (typeof name !== 'string') continue;
    const label = repo.labels.get(name);
    if (!label) return err(422, `Label "${name}" does not exist`);
    labels.push(label);
  }
  const seq = store.tick();
  const issue: Issue = {
    number: repo.nextIssue++,
    title,
    body: str(parsed.value.body),
    state: 'open',
    labels,
    user: VIEWER.login,
    createdSeq: seq,
    updatedSeq: seq,
    comments: [],
  };
  repo.issues.set(issue.number, issue);
  return json(201, issueJson(issue, repo));
}

function listPulls(store: Store, repo: Repo, ctx: ReqCtx): Resp {
  const state = ctx.query.get('state') ?? 'open';
  let pulls = [...repo.pulls.values()];
  if (state !== 'all') pulls = pulls.filter((p) => p.state === state);
  pulls.sort((a, b) => b.createdSeq - a.createdSeq);
  const { page, headers } = paginate(pulls, ctx, pulls.length);
  return json(200, page.map((p) => prJson(p, repo, store)), headers);
}

function createPull(store: Store, repo: Repo, ctx: ReqCtx): Resp {
  const parsed = parseJsonBody(ctx);
  if (!parsed.ok) return parsed.resp;
  const title = str(parsed.value.title);
  const head = str(parsed.value.head);
  const base = str(parsed.value.base);
  if (title === '' || head === '' || base === '') return err(422, 'title, head and base are required');
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return err(422, 'head or base branch does not exist');
  const pr: PullRequest = {
    number: repo.nextPull++,
    title,
    body: str(parsed.value.body),
    state: 'open',
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
  pr.files = computePullFiles(store, repo, pr);
  repo.pulls.set(pr.number, pr);
  return json(201, prJson(pr, repo, store));
}

function mergePull(store: Store, repo: Repo, ctx: ReqCtx, number: number): Resp {
  const pr = repo.pulls.get(number);
  if (!pr) return err(404, 'Not Found');
  if (pr.state !== 'open') return err(405, 'Pull request is not open');
  if (!computeMergeable(store, repo, pr)) return err(405, 'Merge conflict');
  const headTree = store.commitTree(repo, pr.headSha);
  const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? ZERO_OID;
  const ident = serverIdent();
  const message = `Merge pull request #${pr.number} from ${pr.headRef}`;
  const commitData = buildCommit(headTree, baseTip === ZERO_OID ? [] : [baseTip], ident, ident, message);
  const mergeSha = store.putObject(repo, 'commit', commitData);
  repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
  pr.state = 'closed';
  pr.merged = true;
  pr.mergeCommitSha = mergeSha;
  pr.mergedAtSeq = store.tick();
  return json(200, { sha: mergeSha, merged: true, message });
}
