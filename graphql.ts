// graphql.ts — GitHub GraphQL v4 for the documents gh and github-mcp-server send.
// A small recursive-descent parser plus resolvers over the same store REST uses,
// so a mutation here is visible over REST with the same ids. Unknown fields are
// HTTP 200 with an errors array naming them; an unknown repository is
// data.repository = null with no errors; batched bodies answer in order.

import {
  globalId,
  parseGlobalId,
  type Issue,
  type PullRequest,
  type Repo,
  type Store,
} from './store.ts';
import { VIEWER } from './scenario.ts';
import { computeMergeable, computePullFiles } from './rest.ts';
import type { ReqCtx, Resp } from './rest.ts';
import { err, json } from './rest.ts';

// -------------------------------------------------------------------------------------------
// a small GraphQL document parser (operations, variables, aliases, arguments, fragments)
// -------------------------------------------------------------------------------------------

type ValueNode =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: ValueNode[] }
  | { kind: 'object'; fields: Array<{ name: string; value: ValueNode }> };

interface Selection {
  alias: string;
  name: string;
  args: Array<{ name: string; value: ValueNode }>;
  selections: Selection[];
  /** Inline fragment: "... on Type { ... }" — selections apply to `typeCondition`. */
  fragmentType?: string;
}

interface Operation {
  kind: 'query' | 'mutation';
  name?: string;
  variables: Array<{ name: string; type: string }>;
  selections: Selection[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c) || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():![]$=@'.includes(c)) {
      tokens.push(c);
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j += 1;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9-]/.test(src[j])) j += 1;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    i += 1;
  }
  return tokens;
}

class Parser {
  tokens: string[];
  pos = 0;
  constructor(src: string) {
    this.tokens = tokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }
  parseDocument(): Operation[] {
    const ops: Operation[] = [];
    while (this.pos < this.tokens.length) {
      ops.push(this.parseOperation());
    }
    return ops;
  }
  parseOperation(): Operation {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | undefined;
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
      if (this.peek() !== undefined && this.peek() !== '(' && this.peek() !== '{') name = this.next();
    }
    const variables: Array<{ name: string; type: string }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        this.expect('$');
        const vname = this.next();
        this.expect(':');
        let type = '';
        while (this.peek() !== undefined && this.peek() !== ')' && this.peek() !== ',' && this.peek() !== '$') {
          type += this.next();
        }
        variables.push({ name: vname, type });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    const selections = this.parseSelectionSet();
    return { kind, name, variables, selections };
  }
  parseSelectionSet(): Selection[] {
    this.expect('{');
    const out: Selection[] = [];
    while (this.peek() !== '}' && this.peek() !== undefined) {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }
  parseSelection(): Selection {
    if (this.peek() === '...') {
      this.next();
      let fragmentType: string | undefined;
      if (this.peek() === 'on') {
        this.next();
        fragmentType = this.next();
      }
      const selections = this.parseSelectionSet();
      return { alias: '', name: '', args: [], selections, fragmentType };
    }
    let alias = '';
    let name = this.next();
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args: Array<{ name: string; value: ValueNode }> = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')' && this.peek() !== undefined) {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect(')');
    }
    let selections: Selection[] = [];
    if (this.peek() === '{') selections = this.parseSelectionSet();
    return { alias: alias === '' ? name : alias, name, args, selections };
  }
  parseValue(): ValueNode {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: ValueNode[] = [];
      while (this.peek() !== ']' && this.peek() !== undefined) {
        values.push(this.parseValue());
        if (this.peek() === ',') this.next();
      }
      this.expect(']');
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.peek() !== '}' && this.peek() !== undefined) {
        const fname = this.next();
        this.expect(':');
        fields.push({ name: fname, value: this.parseValue() });
        if (this.peek() === ',') this.next();
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: Number(tok) };
    return { kind: 'enum', value: tok };
  }
}

function resolveValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'variable':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'boolean':
      return node.value;
    case 'null':
      return null;
    case 'enum':
      return node.value;
    case 'list':
      return node.values.map((v) => resolveValue(v, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of node.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// -------------------------------------------------------------------------------------------
// schema: the types introspection must describe
// -------------------------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'labels', 'comments', 'url'],
  PullRequest: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'createdAt', 'author', 'headRef', 'baseRef'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'url'],
  SearchType: [],
};

const SEARCH_TYPE_ENUM = ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT'];

// -------------------------------------------------------------------------------------------
// execution
// -------------------------------------------------------------------------------------------

interface ExecCtx {
  store: Store;
  variables: Record<string, unknown>;
  errors: Array<{ message: string; path?: (string | number)[] }>;
}

function argValue(sel: Selection, name: string, ctx: ExecCtx): unknown {
  const arg = sel.args.find((a) => a.name === name);
  if (!arg) return undefined;
  return resolveValue(arg.value, ctx.variables);
}

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexFromCursor(cursor: string | undefined): number {
  if (!cursor) return -1;
  try {
    const raw = Buffer.from(cursor, 'base64').toString('utf8');
    const n = Number(/^cursor:(\d+)$/.exec(raw)?.[1]);
    return Number.isFinite(n) ? n : -1;
  } catch {
    return -1;
  }
}

function repoObject(repo: Repo): Record<string, unknown> {
  return {
    __type: 'Repository',
    id: globalId('repository', repo.owner, repo.name),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { __type: 'User', login: repo.owner, id: VIEWER.id },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    __repo: repo,
  };
}

function issueObject(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    __type: 'Issue',
    id: globalId('issue', repo.owner, repo.name, issue.number),
    number: issue.number,
    title: issue.title,
    // GraphQL states are the OPEN/CLOSED enum, not REST's lowercase strings.
    state: issue.state.toUpperCase(),
    body: issue.body,
    createdAt: '2025-01-01T00:00:00Z',
    updatedAt: '2025-01-01T00:00:00Z',
    author: { __type: 'User', login: issue.user },
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    __repo: repo,
    __issue: issue,
  };
}

function pullObject(store: Store, repo: Repo, pr: PullRequest): Record<string, unknown> {
  const headSha = store.refTip(repo, `refs/heads/${pr.headRef}`);
  const baseSha = store.refTip(repo, `refs/heads/${pr.baseRef}`);
  return {
    __type: 'PullRequest',
    id: globalId('pullrequest', repo.owner, repo.name, pr.number),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    headRefName: pr.headRef,
    baseRefName: pr.baseRef,
    // GitHub's mergeable is a string enum, not a boolean.
    mergeable: computeMergeable(store, repo, pr) ? 'MERGEABLE' : 'CONFLICTING',
    state: pr.state.toUpperCase(),
    merged: pr.merged,
    createdAt: '2025-01-01T00:00:00Z',
    author: { __type: 'User', login: pr.user },
    headRef: { name: pr.headRef, target: { oid: headSha === '0'.repeat(40) ? pr.headSha : headSha } },
    baseRef: { name: pr.baseRef, target: { oid: baseSha === '0'.repeat(40) ? pr.baseSha : baseSha } },
    __repo: repo,
    __pull: pr,
  };
}

/** Resolve one field of a parent object; null when the field does not exist there. */
function resolveField(parent: Record<string, unknown>, sel: Selection, ctx: ExecCtx): unknown {
  const type = parent.__type as string | undefined;
  const name = sel.name;

  // A plain nested object (a field entry, a pageInfo, a connection node) with no
  // __type reads its property directly; only typed parents go through the switch.
  if (type === undefined) {
    if (name in parent) return parent[name];
    return undefined;
  }

  if (type === 'Query') {
    if (name === 'viewer') {
      return { __type: 'User', login: VIEWER.login, id: VIEWER.id };
    }
    if (name === 'repository') {
      const owner = String(argValue(sel, 'owner', ctx) ?? '');
      const repoName = String(argValue(sel, 'name', ctx) ?? '');
      const repo = owner === VIEWER.login ? ctx.store.getRepo(owner, repoName) : undefined;
      return repo ? repoObject(repo) : null;
    }
    if (name === 'node') {
      const id = String(argValue(sel, 'id', ctx) ?? '');
      const parsed = parseGlobalId(id);
      if (!parsed) return null;
      if (parsed.kind === 'repository') {
        const repo = ctx.store.getRepo(parsed.owner, parsed.repo);
        return repo ? repoObject(repo) : null;
      }
      if (parsed.kind === 'issue' && parsed.number !== undefined) {
        const repo = ctx.store.getRepo(parsed.owner, parsed.repo);
        const issue = repo?.issues.get(parsed.number);
        return repo && issue ? issueObject(repo, issue) : null;
      }
      if (parsed.kind === 'pullrequest' && parsed.number !== undefined) {
        const repo = ctx.store.getRepo(parsed.owner, parsed.repo);
        const pr = repo?.pulls.get(parsed.number);
        return repo && pr ? pullObject(ctx.store, repo, pr) : null;
      }
      return null;
    }
    if (name === '__type') {
      const typeName = String(argValue(sel, 'name', ctx) ?? '');
      if (typeName === 'SearchType') return { __type: '__Type', name: 'SearchType', kind: 'ENUM', enumValues: SEARCH_TYPE_ENUM.map((n) => ({ name: n })) };
      if (TYPE_FIELDS[typeName]) return { __type: '__Type', name: typeName, kind: 'OBJECT', fields: TYPE_FIELDS[typeName].map((n) => ({ name: n })) };
      return null;
    }
    if (name === '__schema') return { __type: '__Schema', types: [] };
    return undefined;
  }

  if (type === 'Repository') {
    const repo = parent.__repo as Repo;
    if (name === 'issue') {
      const number = Number(argValue(sel, 'number', ctx));
      const issue = repo.issues.get(number);
      return issue ? issueObject(repo, issue) : null;
    }
    if (name === 'issues') {
      const first = Number(argValue(sel, 'first', ctx) ?? 100);
      const after = indexFromCursor(String(argValue(sel, 'after', ctx) ?? ''));
      const states = argValue(sel, 'states', ctx) as string[] | undefined;
      const orderBy = argValue(sel, 'orderBy', ctx) as { field?: string; direction?: string } | undefined;
      let issues = [...repo.issues.values()];
      if (states) issues = issues.filter((i) => states.includes(i.state.toUpperCase()));
      const desc = orderBy?.direction === 'DESC';
      issues.sort((a, b) => (desc ? b.number - a.number : a.number - b.number));
      const start = after + 1;
      const nodes = issues.slice(start, start + first);
      const end = start + nodes.length;
      return {
        __type: 'IssueConnection',
        nodes: nodes.map((i) => issueObject(repo, i)),
        pageInfo: {
          hasNextPage: end < issues.length,
          endCursor: nodes.length ? cursorFor(start + nodes.length - 1) : null,
          hasPreviousPage: start > 0,
          startCursor: nodes.length ? cursorFor(start) : null,
        },
        totalCount: issues.length,
      };
    }
    if (name === 'pullRequests') {
      const first = Number(argValue(sel, 'first', ctx) ?? 100);
      const after = indexFromCursor(String(argValue(sel, 'after', ctx) ?? ''));
      let pulls = [...repo.pulls.values()].sort((a, b) => b.number - a.number);
      const start = after + 1;
      const nodes = pulls.slice(start, start + first);
      const end = start + nodes.length;
      return {
        __type: 'PullRequestConnection',
        nodes: nodes.map((p) => pullObject(ctx.store, repo, p)),
        pageInfo: { hasNextPage: end < pulls.length, endCursor: nodes.length ? cursorFor(start + nodes.length - 1) : null },
        totalCount: pulls.length,
      };
    }
    if (name === 'pullRequest') {
      const number = Number(argValue(sel, 'number', ctx));
      const pr = repo.pulls.get(number);
      return pr ? pullObject(ctx.store, repo, pr) : null;
    }
    if (name === 'owner') return parent.owner;
    if (name === 'defaultBranchRef') return parent.defaultBranchRef;
    if (name === 'id' || name === 'databaseId' || name === 'name' || name === 'nameWithOwner' || name === 'viewerPermission' || name === 'hasIssuesEnabled' || name === 'description' || name === 'url') {
      return parent[name];
    }
    return undefined;
  }

  if (type === 'PullRequest') {
    const pr = parent.__pull as PullRequest;
    const repo = parent.__repo as Repo;
    if (name === 'files') {
      const first = Number(argValue(sel, 'first', ctx) ?? 100);
      const files = computePullFiles(ctx.store, repo, pr).slice(0, first);
      return { __type: 'PullRequestChangedFileConnection', nodes: files.map((f) => ({ path: f.filename, additions: f.additions, deletions: f.deletions, changeType: f.status.toUpperCase() })) };
    }
    if (['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'createdAt', 'author', 'headRef', 'baseRef'].includes(name)) {
      return parent[name];
    }
    return undefined;
  }

  if (type === 'Issue') {
    if (['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'author', 'url'].includes(name)) {
      return parent[name];
    }
    if (name === 'labels') {
      const issue = parent.__issue as Issue;
      return { __type: 'LabelConnection', nodes: issue.labels.map((l) => ({ name: l.name, color: l.color, description: l.description })) };
    }
    if (name === 'comments') {
      const issue = parent.__issue as Issue;
      return { __type: 'IssueCommentConnection', nodes: issue.comments.map((c) => ({ id: globalId('comment', '', '', c.id), body: c.body })) };
    }
    return undefined;
  }

  if (type === '__Type') {
    if (name === 'fields') {
      const includeDeprecated = argValue(sel, 'includeDeprecated', ctx);
      void includeDeprecated;
      return parent.fields ?? [];
    }
    if (name === 'enumValues') return parent.enumValues ?? [];
    if (name === 'name' || name === 'kind') return parent[name];
    return undefined;
  }

  // Plain nested objects (User, PageInfo, connections): read the property directly.
  if (name in parent) return parent[name];
  return undefined;
}

/** Execute a selection set against a parent value, honouring aliases and fragments. */
function executeSelections(parent: Record<string, unknown>, selections: Selection[], ctx: ExecCtx, path: (string | number)[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.fragmentType !== undefined) {
      const type = (parent.__type as string | undefined) ?? '';
      if (sel.fragmentType !== type) continue;
      Object.assign(out, executeSelections(parent, sel.selections, ctx, path));
      continue;
    }
    if (sel.name === '') continue;
    const value = resolveField(parent, sel, ctx);
    if (value === undefined) {
      ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "${(parent.__type as string | undefined) ?? 'Query'}".`, path: [...path, sel.alias] });
      out[sel.alias] = null;
      continue;
    }
    out[sel.alias] = executeValue(value, sel, ctx, [...path, sel.alias]);
  }
  return out;
}

function executeValue(value: unknown, sel: Selection, ctx: ExecCtx, path: (string | number)[]): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) return value.map((v, i) => executeValue(v, sel, ctx, [...path, i]));
  if (typeof value === 'object') {
    if (sel.selections.length === 0) return value;
    return executeSelections(value as Record<string, unknown>, sel.selections, ctx, path);
  }
  return value;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>): Record<string, unknown> {
  const ctx: ExecCtx = { store, variables, errors: [] };
  const root: Record<string, unknown> = { __type: 'Query' };
  if (op.kind === 'mutation') {
    const data: Record<string, unknown> = {};
    for (const sel of op.selections) {
      const result = runMutation(store, sel, ctx);
      if (result === undefined) {
        ctx.errors.push({ message: `Cannot query field "${sel.name}" on type "Mutation".` });
        data[sel.alias] = null;
      } else {
        data[sel.alias] = executeValue(result, sel, ctx, [sel.alias]);
      }
    }
    return ctx.errors.length ? { data, errors: ctx.errors } : { data };
  }
  const data = executeSelections(root, op.selections, ctx, []);
  return ctx.errors.length ? { data, errors: ctx.errors } : { data };
}

/** Run one mutation field; returns the payload object or undefined for unknown fields. */
function runMutation(store: Store, sel: Selection, ctx: ExecCtx): Record<string, unknown> | undefined {
  const input = (argValue(sel, 'input', ctx) ?? {}) as Record<string, unknown>;
  if (sel.name === 'createIssue') {
    const repoId = String(input.repositoryId ?? '');
    const parsed = parseGlobalId(repoId);
    const repo = parsed ? store.getRepo(parsed.owner, parsed.repo) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return { issue: null };
    }
    const seq = store.tick();
    const issue = {
      number: repo.nextIssue++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
      state: 'open' as const,
      labels: [],
      user: VIEWER.login,
      createdSeq: seq,
      updatedSeq: seq,
      comments: [],
    };
    repo.issues.set(issue.number, issue);
    return { issue: issueObject(repo, issue) };
  }
  if (sel.name === 'closeIssue') {
    const parsed = parseGlobalId(String(input.issueId ?? ''));
    const repo = parsed ? store.getRepo(parsed.owner, parsed.repo) : undefined;
    const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return { issue: null };
    }
    issue.state = 'closed';
    issue.updatedSeq = store.tick();
    return { issue: issueObject(repo, issue) };
  }
  if (sel.name === 'createPullRequest') {
    const parsed = parseGlobalId(String(input.repositoryId ?? ''));
    const repo = parsed ? store.getRepo(parsed.owner, parsed.repo) : undefined;
    if (!repo) {
      ctx.errors.push({ message: 'Could not resolve to a Repository with the provided id.' });
      return { pullRequest: null };
    }
    const head = String(input.headRefName ?? '');
    const base = String(input.baseRefName ?? '');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) {
      ctx.errors.push({ message: 'head or base branch does not exist' });
      return { pullRequest: null };
    }
    const pr: PullRequest = {
      number: repo.nextPull++,
      title: String(input.title ?? ''),
      body: String(input.body ?? ''),
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
    repo.pulls.set(pr.number, pr);
    return { pullRequest: pullObject(store, repo, pr) };
  }
  if (sel.name === 'mergePullRequest') {
    const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
    const repo = parsed ? store.getRepo(parsed.owner, parsed.repo) : undefined;
    const pr = repo && parsed?.number !== undefined ? repo.pulls.get(parsed.number) : undefined;
    if (!repo || !pr) {
      ctx.errors.push({ message: 'Could not resolve to a PullRequest with the provided id.' });
      return { pullRequest: null };
    }
    if (pr.state !== 'open' || !computeMergeable(store, repo, pr)) {
      ctx.errors.push({ message: 'Pull request cannot be merged' });
      return { pullRequest: pullObject(store, repo, pr) };
    }
    const headTree = store.commitTree(repo, pr.headSha);
    const baseTip = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? '0'.repeat(40);
    // Squash merge inline (the same shape as REST): one commit on the base branch
    // whose tree is the head's tree.
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
    return { pullRequest: pullObject(store, repo, pr) };
  }
  if (sel.name === 'addComment') {
    const parsed = parseGlobalId(String(input.subjectId ?? ''));
    const repo = parsed ? store.getRepo(parsed.owner, parsed.repo) : undefined;
    const issue = repo && parsed?.number !== undefined ? repo.issues.get(parsed.number) : undefined;
    if (!repo || !issue) {
      ctx.errors.push({ message: 'Could not resolve to an Issue with the provided id.' });
      return { commentEdge: null };
    }
    const comment = { id: repo.nextCommentId++, body: String(input.body ?? ''), user: VIEWER.login, createdSeq: store.tick() };
    issue.comments.push(comment);
    return { commentEdge: { node: { id: globalId('comment', repo.owner, repo.name, comment.id), body: comment.body } } };
  }
  return undefined;
}

// -------------------------------------------------------------------------------------------
// the endpoint
// -------------------------------------------------------------------------------------------

export function handleGraphQL(store: Store, ctx: ReqCtx): Resp {
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
    return json(200, { errors: [{ message: 'Invalid JSON body' }] });
  }
  const runOne = (op: { query?: string; variables?: Record<string, unknown>; operationName?: string }): Record<string, unknown> => {
    const query = typeof op.query === 'string' ? op.query : '';
    const variables = (op.variables ?? {}) as Record<string, unknown>;
    let operations: Operation[];
    try {
      operations = new Parser(query).parseDocument();
    } catch (e) {
      return { errors: [{ message: e instanceof Error ? e.message : 'Parse error' }] };
    }
    let chosen = operations[0];
    if (op.operationName) chosen = operations.find((o) => o.name === op.operationName) ?? chosen;
    if (!chosen) return { errors: [{ message: 'No operation provided' }] };
    return executeOperation(store, chosen, variables);
  };
  if (Array.isArray(body)) {
    return json(200, body.map((op) => runOne(op as { query?: string; variables?: Record<string, unknown> })));
  }
  if (body !== null && typeof body === 'object') {
    return json(200, runOne(body as { query?: string; variables?: Record<string, unknown> }));
  }
  return json(200, { errors: [{ message: 'Invalid GraphQL body' }] });
}
