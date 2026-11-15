// git.ts — the git smart-HTTP wire, implemented on node:zlib and node:crypto only.
// upload-pack speaks protocol v2 when the client asks (Git-Protocol: version=2)
// and v0 otherwise; receive-pack is v0 only. Packs are plain (no deltas): every
// object zlib-compressed whole, with a SHA-1 trailer. The suite's client accepts
// plain packs, and building them is O(objects) with no delta search to pay for.

import { createHash, randomUUID } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  buildTree,
  hashObject,
  isOid,
  parseCommit,
  parseTree,
  ZERO_OID,
  type GitObject,
  type GitObjectType,
  type Repo,
  type Store,
} from './store.ts';

// -------------------------------------------------------------------------------------------
// pkt-line framing
// -------------------------------------------------------------------------------------------

export type PktKind = 'data' | 'flush' | 'delim' | 'response-end';

export interface Packet {
  kind: PktKind;
  payload: Buffer;
}

/** One pkt-line: 4 hex digits of total length (header included) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const len = data.length + 4;
  const head = Buffer.alloc(4);
  head.write(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, data]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function encodePktLines(items: Array<string | Buffer | 'flush' | 'delim'>): Buffer {
  const parts: Buffer[] = [];
  for (const item of items) {
    if (item === 'flush') parts.push(FLUSH);
    else if (item === 'delim') parts.push(DELIM);
    else parts.push(pktLine(item));
  }
  return Buffer.concat(parts);
}

/** Decode every pkt-line in a buffer; throws on a malformed length. */
export function decodePktLines(buf: Buffer): Packet[] {
  const out: Packet[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('pkt-line header truncated');
    const hex = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error(`bad pkt-line length ${JSON.stringify(hex)}`);
    const len = parseInt(hex, 16);
    if (len === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (len === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + len > buf.length) throw new Error('pkt-line body truncated');
      out.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + len) });
      offset += len;
    }
  }
  return out;
}

/** A cursor over pkt-lines that stops at the first flush and reports where it stopped. */
export function readCommands(buf: Buffer): { lines: string[]; rest: Buffer } {
  const lines: string[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const len = parseInt(buf.subarray(offset, offset + 4).toString('ascii'), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line length in command stream');
    if (len === 0) {
      offset += 4;
      return { lines, rest: buf.subarray(offset) };
    }
    if (len === 1 || len === 2) {
      offset += 4;
      continue;
    }
    if (offset + len > buf.length) throw new Error('pkt-line body truncated in command stream');
    lines.push(buf.subarray(offset + 4, offset + len).toString('utf8'));
    offset += len;
  }
  throw new Error('command stream ended without a flush packet');
}

/** Split one sideband packet stream into pack bytes (band 1) and progress text (band 2). */
export function sideband(pack: Buffer, chunkSize = 32768): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + chunkSize));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// packfiles
// -------------------------------------------------------------------------------------------

const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let remaining = size;
  let first = (code << 4) | (remaining & 0x0f);
  remaining = Math.floor(remaining / 16);
  while (remaining > 0) {
    bytes.push(first | 0x80);
    first = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
  }
  bytes.push(first);
  return Buffer.from(bytes);
}

/** Build a plain packfile (version 2, no deltas) from objects, with a SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 4, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  return Buffer.concat([body, createHash('sha1').update(body).digest()]);
}

/** The empty pack: header, zero objects, trailer. */
export function emptyPack(): Buffer {
  return writePack([]);
}

interface RawEntry {
  offset: number;
  typeCode: number;
  size: number;
  data: Buffer;
  baseOffset?: number;
  baseOid?: string;
}

function readVarintSize(buf: Buffer, offset: number): { size: number; first: number; next: number } {
  let size = buf[offset] & 0x0f;
  let shift = 4;
  let next = offset + 1;
  const first = buf[offset];
  while (buf[next - 1] & 0x80) {
    size += (buf[next] & 0x7f) * 2 ** shift;
    shift += 7;
    next += 1;
  }
  return { size, first, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta size varint truncated');
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.allocUnsafe(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta size mismatch');
  return out;
}

/**
 * Read a packfile and resolve every object, including OFS_DELTA and REF_DELTA.
 * `resolveBase` supplies a base a thin pack leaves out. Every object's SHA-1 is
 * recomputed; a mismatch is an error, so corruption is never stored as success.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32) throw new Error('pack too short');
  if (pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('pack does not start with PACK');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const declaredCount = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const trailer = pack.subarray(trailerStart).toString('hex');
  const computed = createHash('sha1').update(pack.subarray(0, trailerStart)).digest('hex');
  if (trailer !== computed) throw new Error('pack trailer checksum mismatch');

  const raw: RawEntry[] = [];
  const byOffset = new Map<number, RawEntry>();
  let offset = 12;
  for (let i = 0; i < declaredCount; i += 1) {
    const entryOffset = offset;
    const header = readVarintSize(pack, offset);
    offset = header.next;
    const typeCode = (header.first >> 4) & 0x07;
    const entry: RawEntry = { offset: entryOffset, typeCode, size: header.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      // OFS_DELTA: the base offset is a variable-length negative offset.
      let byte = pack[offset++];
      let baseOffset = byte & 0x7f;
      while (byte & 0x80) {
        byte = pack[offset++];
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      entry.baseOffset = entryOffset - baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`pack entry ${i} has unknown type code ${typeCode}`);
    }
    const inflated = inflateAt(pack, offset, trailerStart);
    if (inflated.data.length !== header.size) throw new Error('pack entry size mismatch after inflate');
    entry.data = inflated.data;
    offset = inflated.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (offset !== trailerStart) throw new Error('pack has stray bytes before its trailer');

  const objects = new Map<string, GitObject>();
  const resolvedByOid = new Map<string, RawEntry>();
  const resolving = new Set<number>();
  const resolve = (entry: RawEntry): { type: GitObjectType; data: Buffer; oid: string } => {
    const cached = (entry as unknown as { _r?: { type: GitObjectType; data: Buffer; oid: string } })._r;
    if (cached) return cached;
    if (resolving.has(entry.offset)) throw new Error('delta cycle in pack');
    resolving.add(entry.offset);
    let type: GitObjectType;
    let data: Buffer;
    if (entry.typeCode === 6) {
      const baseEntry = byOffset.get(entry.baseOffset!);
      if (!baseEntry) throw new Error('ofs-delta base is not in the pack');
      const base = resolve(baseEntry);
      type = base.type;
      data = applyDelta(base.data, entry.data);
    } else if (entry.typeCode === 7) {
      const baseEntry = resolvedByOid.get(entry.baseOid!);
      if (baseEntry) {
        const base = resolve(baseEntry);
        type = base.type;
        data = applyDelta(base.data, entry.data);
      } else {
        const external = resolveBase?.(entry.baseOid!);
        if (!external) throw new Error(`ref-delta base ${entry.baseOid} is not available`);
        type = external.type;
        data = applyDelta(external.data, entry.data);
      }
    } else {
      type = CODE_TYPE[entry.typeCode];
      data = entry.data;
    }
    const oid = hashObject(type, data);
    const result = { type, data, oid };
    (entry as unknown as { _r?: unknown })._r = result;
    resolvedByOid.set(oid, entry);
    resolving.delete(entry.offset);
    return result;
  };
  for (const entry of raw) {
    const resolved = resolve(entry);
    if (!objects.has(resolved.oid)) objects.set(resolved.oid, { type: resolved.type, data: resolved.data });
  }
  return objects;
}

/**
 * Inflate one zlib stream starting at `offset` (bounded by `end`): Node's
 * inflateSync with {info:true} reports engine.bytesWritten as the number of
 * input bytes the stream consumed, which is exactly the stream's length.
 */
function inflateAt(buf: Buffer, offset: number, end: number): { data: Buffer; next: number } {
  const view = buf.subarray(offset, end);
  const result = inflateSync(view, { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  const consumed = result.engine.bytesWritten;
  if (!consumed || consumed <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + consumed };
}

// -------------------------------------------------------------------------------------------
// ref listing
// -------------------------------------------------------------------------------------------

export interface RefLine {
  oid: string;
  name: string;
  peeled?: string;
  symrefTarget?: string;
  unborn?: boolean;
}

const HEAD_REF = 'refs/heads/main';

/** The repository's refs as advertised lines, HEAD first, then heads, then tags. */
export function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const mainTip = repo.refs.get(HEAD_REF) ?? ZERO_OID;
  lines.push({ oid: mainTip, name: 'HEAD', symrefTarget: HEAD_REF, unborn: mainTip === ZERO_OID });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name)!;
    const object = repo.objects.get(oid);
    const line: RefLine = { oid, name };
    if (object?.type === 'tag') {
      const text = object.data.toString('utf8');
      const target = /^object ([0-9a-f]{40})$/m.exec(text)?.[1];
      if (target) line.peeled = target;
    }
    lines.push(line);
  }
  return lines;
}

const AGENT = 'github-core-clone-forge/1.0.0';

/** The v2 capability advertisement: "version 2" plus one capability per line. */
export function advertisementV2(): Buffer {
  return encodePktLines([
    'version 2\n',
    `agent=${AGENT}\n`,
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    'flush',
  ]);
}

/** The v0 upload-pack advertisement: service preamble, then refs with capabilities. */
export function advertisementV0Upload(repo: Repo): Buffer {
  const caps = `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:${HEAD_REF} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-upload-pack\n'), FLUSH];
  const refs = advertisedRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get(HEAD_REF) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v0 receive-pack advertisement: service preamble, refs, push capabilities. */
export function advertisementV0Receive(repo: Repo): Buffer {
  const caps = `report-status report-status-v2 side-band-64k delete-refs ofs-delta symref=HEAD:${HEAD_REF} agent=${AGENT}`;
  const parts: Buffer[] = [pktLine('# service=git-receive-pack\n'), FLUSH];
  const refs = advertisedRefs(repo).filter((r) => r.name !== 'HEAD');
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const mainTip = repo.refs.get(HEAD_REF) ?? ZERO_OID;
    parts.push(pktLine(`${mainTip} HEAD\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.peeled) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// fetch object selection
// -------------------------------------------------------------------------------------------

export interface FetchPlan {
  /** Objects to send, in pack order (commits first, then the rest). */
  objects: GitObject[];
  /** New shallow boundaries, or [] when the fetch is not shallow. */
  shallow: string[];
  /** Old boundaries that are no longer shallow. */
  unshallow: string[];
  /** Common haves the server acknowledged. */
  acks: string[];
}

/**
 * Work out what a fetch sends. `wants` are the wanted oids, `haves` the client's,
 * `shallowBoundaries` its current shallow file, `depth` the requested deepen.
 * A commit is sent only when it lies within `depth` generations of a want; trees and
 * blobs follow their commits. Anything reachable from a have (stopping at that
 * have's own shallow boundary) is already held and never re-sent.
 */
export function planFetch(
  store: Store,
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth?: number,
): FetchPlan {
  const boundarySet = new Set(shallowBoundaries);
  // Commits the client holds: from its haves, not descending past a shallow boundary.
  const heldCommits = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length > 0) {
      const oid = queue.shift()!;
      if (heldCommits.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      heldCommits.add(oid);
      if (boundarySet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) queue.push(parent);
    }
  }
  // Objects the client holds: the held commits plus each one's tree closure.
  // (A plain reachable-objects walk would descend past a shallow boundary and
  // wrongly treat the history below it as held.)
  const heldObjects = new Set<string>();
  for (const oid of heldCommits) {
    heldObjects.add(oid);
    const object = repo.objects.get(oid);
    if (!object || object.type !== 'commit') continue;
    for (const [path, entry] of store.flatTree(repo, parseCommit(object.data).tree)) {
      void path;
      heldObjects.add(entry.oid);
    }
    heldObjects.add(parseCommit(object.data).tree);
  }
  // The wants' commits within the depth limit (depth 1 = the wants themselves).
  const wantCommits = new Map<string, number>();
  {
    const queue: Array<[string, number]> = wants.filter(isOid).map((oid) => [oid, 0] as [string, number]);
    while (queue.length > 0) {
      const [oid, d] = queue.shift()!;
      if (wantCommits.has(oid)) continue;
      const object = repo.objects.get(oid);
      if (!object) continue;
      if (object.type === 'tag') {
        const target = /^object ([0-9a-f]{40})$/m.exec(object.data.toString('utf8'))?.[1];
        if (target) queue.push([target, d]);
        continue;
      }
      if (object.type !== 'commit') continue;
      wantCommits.set(oid, d);
      if (depth === undefined || d + 1 < depth) {
        for (const parent of parseCommit(object.data).parents) queue.push([parent, d + 1]);
      }
    }
  }
  const acks = haves.filter((oid) => heldCommits.has(oid) || wantCommits.has(oid));
  // Objects to send: the want commits' closure minus what the client holds.
  const send = new Set<string>();
  for (const oid of wantCommits.keys()) {
    if (heldObjects.has(oid)) continue;
    send.add(oid);
    const object = repo.objects.get(oid);
    if (object?.type === 'commit') {
      const tree = parseCommit(object.data).tree;
      for (const x of store.reachableObjects(repo, [tree])) {
        if (!heldObjects.has(x)) send.add(x);
      }
    }
  }
  // Tags asked for directly also travel whole.
  for (const oid of wants) {
    const object = repo.objects.get(oid);
    if (object?.type === 'tag' && !heldObjects.has(oid)) send.add(oid);
  }
  // New shallow boundaries: want commits at the depth cutoff that still have parents.
  const shallow: string[] = [];
  const unshallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, d] of wantCommits) {
      const object = repo.objects.get(oid);
      if (!object || object.type !== 'commit') continue;
      const parents = parseCommit(object.data).parents;
      if (d === depth - 1 && parents.length > 0) shallow.push(oid);
    }
    for (const old of shallowBoundaries) {
      if (!wantCommits.has(old)) continue;
      const object = repo.objects.get(old);
      if (!object || object.type !== 'commit') continue;
      // No longer shallow once its parents are present in what we send or hold.
      const parents = parseCommit(object.data).parents;
      if (parents.length === 0 || parents.every((p) => wantCommits.has(p) || heldCommits.has(p))) {
        if (!shallow.includes(old)) unshallow.push(old);
      }
    }
  }
  const ordered: GitObject[] = [];
  const seen = new Set<string>();
  for (const oid of send) {
    const object = repo.objects.get(oid);
    if (object && !seen.has(oid)) {
      seen.add(oid);
      ordered.push(object);
    }
  }
  // Commits first (so a reader sees parents after children only when it must), then the rest.
  ordered.sort((a, b) => {
    const rank = (t: GitObjectType): number => (t === 'commit' ? 0 : t === 'tag' ? 1 : t === 'tree' ? 2 : 3);
    return rank(a.type) - rank(b.type);
  });
  return { objects: ordered, shallow, unshallow, acks };
}

// -------------------------------------------------------------------------------------------
// upload-pack
// -------------------------------------------------------------------------------------------

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth?: number;
  deepenSince?: number;
  deepenNot: string[];
  done: boolean;
  filter?: string;
}

/** Parse a v2 fetch/ls-refs request body into its command and arguments. */
export function parseV2Request(body: Buffer): { command: string; args: Map<string, string[]> } {
  const packets = decodePktLines(body);
  const args = new Map<string, string[]>();
  let command = '';
  let pastDelim = false;
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind === 'delim') {
      pastDelim = true;
      continue;
    }
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '');
    if (!pastDelim) {
      const match = /^command=(\S+)$/.exec(line);
      if (match) command = match[1];
      continue;
    }
    const space = line.indexOf(' ');
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? '' : line.slice(space + 1);
    const list = args.get(key) ?? [];
    list.push(value);
    args.set(key, list);
  }
  return { command, args };
}

/** The v2 fetch response: acknowledgments, shallow-info, then the packfile section. */
export function fetchResponseV2(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  const ackLines: Array<string | 'flush'> = ['acknowledgments\n'];
  if (plan.acks.length === 0) {
    ackLines.push('NAK\n');
  } else {
    for (const ack of plan.acks) ackLines.push(`ACK ${ack}\n`);
    ackLines.push('ready\n');
  }
  ackLines.push('flush');
  parts.push(encodePktLines(ackLines));
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    const lines: Array<string | 'flush'> = ['shallow-info\n'];
    for (const oid of plan.shallow) lines.push(`shallow ${oid}\n`);
    for (const oid of plan.unshallow) lines.push(`unshallow ${oid}\n`);
    lines.push('flush');
    parts.push(encodePktLines(lines));
  }
  parts.push(pktLine('packfile\n'));
  parts.push(sideband(writePack(plan.objects)));
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

/** The v0 fetch response: NAK/ACK lines, shallow lines, then the sideband pack. */
export function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length === 0) parts.push(pktLine('NAK\n'));
  else for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(writePack(plan.objects)));
  return Buffer.concat(parts);
}

/** The v2 ls-refs response for a set of refs, honouring ref-prefix filters. */
export function lsRefsResponse(refs: RefLine[], prefixes: string[]): Buffer {
  const keep = (name: string): boolean =>
    prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  for (const ref of refs) {
    if (!keep(ref.name)) continue;
    if (ref.unborn) {
      parts.push(pktLine(`unborn ${ref.name} symref-target:${ref.symrefTarget ?? HEAD_REF}\n`));
      continue;
    }
    const attrs: string[] = [];
    if (ref.symrefTarget) attrs.push(`symref-target:${ref.symrefTarget}`);
    if (ref.peeled) attrs.push(`peeled:${ref.peeled}`);
    parts.push(pktLine(`${ref.oid} ${ref.name}${attrs.length ? ` ${attrs.join(' ')}` : ''}\n`));
  }
  parts.push(FLUSH);
  return Buffer.concat(parts);
}

// -------------------------------------------------------------------------------------------
// receive-pack
// -------------------------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushReportLine {
  ref: string;
  ok: boolean;
  reason: string;
}

/**
 * Apply a push: store the pack's objects, then move each ref that fast-forwards.
 * A refused ref moves nothing; an accepted one moves even when a sibling is refused.
 * Returns one report line per command, in command order.
 */
export function applyPush(store: Store, repo: Repo, commands: PushCommand[]): { unpackOk: boolean; lines: PushReportLine[] } {
  const lines: PushReportLine[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO_OID;
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === ZERO_OID) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      } else {
        repo.refs.delete(command.ref);
        lines.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (!newObject) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    if (current === ZERO_OID) {
      if (command.oldOid !== ZERO_OID) {
        lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push({ ref: command.ref, ok: true, reason: '' });
      continue;
    }
    if (command.oldOid !== current) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    const ok = store.isAncestor(repo, current, command.newOid);
    if (!ok) {
      lines.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push({ ref: command.ref, ok: true, reason: '' });
  }
  return { unpackOk: true, lines };
}

/** The report-status stream, framed in sideband band 1 as the client parses it. */
export function pushReportResponse(lines: PushReportLine[], unpackOk = true): Buffer {
  const text: string[] = [unpackOk ? 'unpack ok\n' : 'unpack error\n'];
  for (const line of lines) {
    text.push(line.ok ? `ok ${line.ref}\n` : `ng ${line.ref} ${line.reason}\n`);
  }
  const inner = encodePktLines([...text, 'flush']);
  return sideband(inner);
}

/** Parse a receive-pack request body: commands, then the raw pack that follows. */
export function parsePushBody(body: Buffer): { commands: PushCommand[]; pack: Buffer } {
  const { lines, rest } = readCommands(body);
  const commands: PushCommand[] = [];
  for (const line of lines) {
    const clean = line.replace(/\n$/, '');
    const nul = clean.indexOf('\0');
    const head = nul < 0 ? clean : clean.slice(0, nul);
    const parts = head.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(clean.slice(0, 60))}`);
    const [oldOid, newOid, ref] = parts;
    if (!isOid(oldOid) || !isOid(newOid) || !ref.startsWith('refs/')) {
      throw new Error('bad push command fields');
    }
    commands.push({ oldOid, newOid, ref });
  }
  if (commands.length === 0) throw new Error('push with no commands');
  return { commands, pack: rest };
}

/** A request id for X-GitHub-Request-Id: deterministic, sequential, no clock. */
export function requestId(): string {
  return `req-${randomUUID()}`;
}
