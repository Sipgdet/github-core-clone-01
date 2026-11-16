// store.ts — the forge's whole state: git objects, refs, repositories, issues,
// pull requests, labels and comments, all in memory. One process, one store; the
// suite is the only client and a trial starts empty, so there is no persistence
// and no cross-trial state to keep. Everything time-like is a deterministic
// counter, never a wall clock, so two runs on the same instance export the same
// state byte for byte.

import { createHash } from 'node:crypto';
import { VIEWER } from './scenario.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export const ZERO_OID = '0'.repeat(40);

/** A git object: its type and raw bytes. Its id is sha1("<type> <len>\0" + bytes). */
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

export function hashObject(type: GitObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function isOid(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value);
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries: "<mode> <name>\0<20-byte oid>" each. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString('ascii'),
      name: data.subarray(space + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object from entries, sorted git-style (directories sort as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object's headers and message. */
export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? '' : text.slice(split + 2);
  const view: CommitView = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) view.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) view.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) view.author = line.slice(7);
    else if (line.startsWith('committer ')) view.committer = line.slice(10);
  }
  return view;
}

/** Build a commit object. Timestamps are the caller's; the forge passes fixed ones. */
export function buildCommit(tree: string, parents: string[], author: string, committer: string, message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${author}`, `committer ${committer}`, '', message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** The fixed identity and timestamp every server-built commit carries. */
export const SERVER_EPOCH = 1_700_000_000;
export function serverIdent(): string {
  return `${VIEWER.name} <${VIEWER.email}> ${SERVER_EPOCH} +0000`;
}

// -------------------------------------------------------------------------------------------
// the store
// -------------------------------------------------------------------------------------------

export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
}

export interface IssueComment {
  id: number;
  body: string;
  user: string;
  createdSeq: number;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  user: string;
  createdSeq: number;
  updatedSeq: number;
  comments: IssueComment[];
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergeable: boolean;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  mergeCommitSha: string | null;
  mergedAtSeq: number | null;
  user: string;
  createdSeq: number;
  /** Files changed by the pull, computed at creation and refreshed on read. */
  files: PullFile[];
}

export interface PullFile {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  createdSeq: number;
  /** ref name -> tip oid. */
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  /** Bumped on every object added: the upload-pack fetch cache keys on it,
   * so a cached response can only be reused while the object store is
   * byte-identical to when the response was computed. */
  rev: number;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  nextIssue: number;
  nextCommentId: number;
  pulls: Map<number, PullRequest>;
  nextPull: number;
}

/** The whole forge, in memory. */
export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 5000;
  nextLabelId = 1;
  /** Monotonic sequence standing in for created/updated times. */
  seq = 1;

  tick(): number {
    return this.seq++;
  }

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER.login,
      description,
      private: isPrivate,
      defaultBranch: 'main',
      createdSeq: this.tick(),
      refs: new Map(),
      objects: new Map(),
      rev: 0,
      labels: new Map(),
      issues: new Map(),
      nextIssue: 1,
      nextCommentId: 1,
      pulls: new Map(),
      nextPull: 1,
    };
    this.repos.set(this.key(repo.owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** The viewer's repositories, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
  }

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.rev++;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  /** The tip of a ref, or the zero oid when the ref does not exist. */
  refTip(repo: Repo, ref: string): string {
    return repo.refs.get(ref) ?? ZERO_OID;
  }

  /** All commits reachable from `tips`, first-come order, with their depth from a tip. */
  reachableCommits(repo: Repo, tips: Iterable<string>): Map<string, number> {
    const seen = new Map<string, number>();
    const queue: Array<[string, number]> = [];
    for (const tip of tips) {
      if (isOid(tip) && tip !== ZERO_OID) queue.push([tip, 0]);
    }
    // Index pointer, not shift(): shift() reindexes the array on every pop,
    // making a 400-commit walk quadratic.
    let head = 0;
    while (head < queue.length) {
      const [oid, depth] = queue[head++]!;
      if (seen.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      seen.set(oid, depth);
      for (const parent of parseCommit(object.data).parents) queue.push([parent, depth + 1]);
    }
    return seen;
  }

  /** Every object reachable from `tips` (commits, their trees recursively, and tags peeled). */
  reachableObjects(repo: Repo, tips: Iterable<string>): Set<string> {
    const out = new Set<string>();
    const commits = this.reachableCommits(repo, tips);
    const visitTree = (oid: string): void => {
      if (out.has(oid)) return;
      const object = repo.objects.get(oid);
      if (!object) return;
      out.add(oid);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) visitTree(entry.oid);
      }
    };
    for (const oid of tips) {
      if (!isOid(oid) || oid === ZERO_OID) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        const text = object.data.toString('utf8');
        const target = /^object ([0-9a-f]{40})$/m.exec(text)?.[1];
        if (target) {
          if (repo.objects.get(target)?.type === 'commit') {
            for (const c of this.reachableCommits(repo, [target]).keys()) {
              out.add(c);
              visitTree(parseCommit(repo.objects.get(c)!.data).tree);
            }
          } else {
            visitTree(target);
          }
        }
        out.add(oid);
        continue;
      }
      if (object.type === 'commit') {
        for (const c of commits.keys()) {
          out.add(c);
          visitTree(parseCommit(repo.objects.get(c)!.data).tree);
        }
      } else {
        visitTree(oid);
      }
    }
    return out;
  }

  /** The tree oid at a commit, or '' when the commit is unknown. */
  commitTree(repo: Repo, commitOid: string): string {
    const object = repo.objects.get(commitOid);
    if (!object || object.type !== 'commit') return '';
    return parseCommit(object.data).tree;
  }

  /** A flat map of path -> { oid, mode } for the tree at a commit. */
  flatTree(repo: Repo, treeOid: string, prefix = ''): Map<string, { oid: string; mode: string }> {
    const out = new Map<string, { oid: string; mode: string }>();
    const walk = (oid: string, base: string): void => {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'tree') return;
      for (const entry of parseTree(object.data)) {
        const path = base === '' ? entry.name : `${base}/${entry.name}`;
        if (entry.mode === '40000') walk(entry.oid, path);
        else out.set(path, { oid: entry.oid, mode: entry.mode });
      }
    };
    walk(treeOid, prefix);
    return out;
  }

  /** The merge-base of two commits: the nearest common ancestor (first-parent walk). */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const fromA = this.reachableCommits(repo, [a]);
    const fromB = this.reachableCommits(repo, [b]);
    let best: string | null = null;
    let bestDepth = Infinity;
    for (const [oid, depth] of fromA) {
      if (fromB.has(oid) && depth < bestDepth) {
        best = oid;
        bestDepth = depth;
      }
    }
    return best;
  }

  /** True when `ancestor` is reachable from `tip` (or equal to it). */
  isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
    if (ancestor === tip) return true;
    // Targeted walk from the tip: stop the moment the ancestor is found.
    // Same answer as reachableCommits(tip).has(ancestor) in every case — a
    // full DAG walk when the ancestor is absent — but a fast-forward push
    // (the common case: the tip's parent IS the current ref) finds it after
    // parsing a single commit instead of the whole history.
    const seen = new Set<string>();
    const queue: string[] = [tip];
    let head = 0;
    while (head < queue.length) {
      const oid = queue[head++]!;
      if (oid === ancestor) return true;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
    return false;
  }
}

/** A global id: base64url of "<kind>:<owner>/<repo>#<number>" or "<kind>:<owner>/<repo>". */
export function globalId(kind: string, owner: string, repo: string, number?: number): string {
  const raw = number === undefined ? `${kind}:${owner}/${repo}` : `${kind}:${owner}/${repo}#${number}`;
  return Buffer.from(raw, 'utf8').toString('base64url');
}

/** Decode a global id back into its parts; null when it is not one of ours. */
export function parseGlobalId(id: string): { kind: string; owner: string; repo: string; number?: number } | null {
  try {
    const raw = Buffer.from(id, 'base64url').toString('utf8');
    const match = /^([a-z]+):([A-Za-z0-9][A-Za-z0-9._-]*)\/([A-Za-z0-9][A-Za-z0-9._-]*)(?:#(\d+))?$/.exec(raw);
    if (!match) return null;
    return {
      kind: match[1],
      owner: match[2],
      repo: match[3],
      number: match[4] === undefined ? undefined : Number(match[4]),
    };
  } catch {
    return null;
  }
}
