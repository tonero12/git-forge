// git.ts — the git object model, packfiles and the pkt-line codec, in pure Node
// (the trial has no git binary). Objects are stored and returned byte-for-byte:
// an object is its SHA-1 over "<type> <len>\0" + raw bytes, exactly as git defines.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: GitObjectType;
  readonly data: Buffer;
}

export const ZERO_OID = '0000000000000000000000000000000000000000';

const TYPE_CODE: Readonly<Record<GitObjectType, number>> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Readonly<Record<number, GitObjectType>> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Uint8Array): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

export function makeObject(type: GitObjectType, data: Buffer): { oid: string; object: GitObject } {
  return { oid: hashObject(type, data), object: { type, data } };
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Uint8Array): TreeEntry[] {
  const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const space = buffer.indexOf(0x20, offset);
    const nul = buffer.indexOf(0x00, space);
    const mode = buffer.toString('utf8', offset, space);
    const name = buffer.toString('utf8', space + 1, nul);
    const oid = buffer.toString('hex', nul + 1, nul + 21);
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' || entry.mode === '040000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- commits and tags

export interface CommitView {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Uint8Array): CommitView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  let author = '';
  let committer = '';
  const parents: string[] = [];
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(fields: {
  readonly tree: string;
  readonly parents: readonly string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}): Buffer {
  const lines = [`tree ${fields.tree}`];
  for (const parent of fields.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${fields.author}`);
  lines.push(`committer ${fields.committer}`);
  const message = fields.message.endsWith('\n') ? fields.message : `${fields.message}\n`;
  return Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
}

export interface TagView {
  readonly object: string;
  readonly type: string;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Uint8Array): TagView {
  const text = Buffer.from(data).toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const view: TagView = { object: '', type: '', tag: '', tagger: '', message: split === -1 ? '' : text.slice(split + 2) };
  const mutable = view as { object: string; type: string; tag: string; tagger: string };
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) mutable.object = line.slice(7).trim();
    else if (line.startsWith('type ')) mutable.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) mutable.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) mutable.tagger = line.slice(7);
  }
  return view;
}

/** The commit a ref ultimately points at, peeling tag objects; null when unpeelable. */
export function peelToCommit(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const object = store.get(current);
    if (object === undefined) return null;
    if (object.type === 'commit') return current;
    if (object.type === 'tag') {
      current = parseTag(object.data).object;
      continue;
    }
    return null;
  }
  return null;
}

/** The object a tag points at (one peel step), or null. */
export function tagTarget(store: ReadonlyMap<string, GitObject>, oid: string): string | null {
  const object = store.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------- reachability

/** Every oid reachable from `roots`; commits named in `cutCommits` are included but their parents are not walked. */
export function closureOf(store: ReadonlyMap<string, GitObject>, roots: readonly string[], cutCommits?: ReadonlySet<string>): Set<string> {
  const seen = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined) continue;
    seen.add(oid);
    if (object.type === 'commit') {
      const commit = parseCommit(object.data);
      stack.push(commit.tree);
      if (cutCommits === undefined || !cutCommits.has(oid)) {
        for (const parent of commit.parents) stack.push(parent);
      }
    } else if (object.type === 'tree') {
      for (const entry of parseTree(object.data)) {
        if (entry.mode !== '160000') stack.push(entry.oid);
      }
    } else if (object.type === 'tag') {
      stack.push(parseTag(object.data).object);
    }
  }
  return seen;
}

export interface CollectResult {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * The object set a fetch must send: closure(wants, truncated at `depth` commit
 * generations) minus the client's effective haves (whose own closure is cut at
 * the shallow boundary the client reported). Mirrors the suite's semantics:
 * re-sending even one already-held object is a conformance failure.
 */
export function collectToSend(
  store: ReadonlyMap<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
  shallowRequest: readonly string[],
  depth: number | undefined,
): CollectResult {
  const cuts = new Set(shallowRequest);
  const haveSet = closureOf(store, haves, cuts);
  const objects = new Map<string, GitObject>();
  const addWithTreeClosure = (rootOid: string): void => {
    // Adds a non-commit object and everything under it (trees/blobs/tags), minus haves.
    const stack = [rootOid];
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (objects.has(oid) || haveSet.has(oid)) continue;
      const object = store.get(oid);
      if (object === undefined) continue;
      objects.set(oid, object);
      if (object.type === 'tree') {
        for (const entry of parseTree(object.data)) {
          if (entry.mode !== '160000') stack.push(entry.oid);
        }
      } else if (object.type === 'tag') {
        stack.push(parseTag(object.data).object);
      }
    }
  };

  const maxDepth = depth === undefined || depth <= 0 ? Number.POSITIVE_INFINITY : depth;
  const depthOf = new Map<string, number>();
  const queue: Array<{ oid: string; depth: number }> = [];
  const enqueueCommit = (oid: string, atDepth: number): void => {
    const known = depthOf.get(oid);
    if (known !== undefined && known <= atDepth) return;
    depthOf.set(oid, atDepth);
    queue.push({ oid, depth: atDepth });
  };

  for (const want of wants) {
    const object = store.get(want);
    if (object === undefined) continue;
    if (object.type === 'commit') {
      // A held commit still seeds the walk: a deepen request wants its parents.
      enqueueCommit(want, 1);
    } else if (haveSet.has(want)) {
      continue;
    } else if (object.type === 'tag') {
      // Walk the tag chain down to its target; a commit target joins the depth walk at depth 1.
      let current = want;
      for (let guard = 0; guard < 32; guard += 1) {
        const tagObject = store.get(current);
        if (tagObject === undefined || haveSet.has(current)) break;
        if (tagObject.type !== 'tag') {
          if (tagObject.type === 'commit') enqueueCommit(current, 1);
          else addWithTreeClosure(current);
          break;
        }
        if (!objects.has(current)) objects.set(current, tagObject);
        current = parseTag(tagObject.data).object;
      }
    } else {
      addWithTreeClosure(want);
    }
  }

  while (queue.length > 0) {
    const { oid, depth: atDepth } = queue.shift() as { oid: string; depth: number };
    if (depthOf.get(oid) !== atDepth) continue; // superseded by a shallower enqueue
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const held = haveSet.has(oid);
    if (!held && !objects.has(oid)) {
      objects.set(oid, object);
      addWithTreeClosure(parseCommit(object.data).tree);
    }
    if (atDepth < maxDepth) {
      for (const parent of parseCommit(object.data).parents) {
        enqueueCommit(parent, atDepth + 1);
      }
    }
  }

  const shallow: string[] = [];
  if (Number.isFinite(maxDepth)) {
    for (const [oid, object] of objects) {
      if (object.type !== 'commit') continue;
      if (depthOf.get(oid) !== maxDepth) continue;
      const commit = parseCommit(object.data);
      const cut = commit.parents.some((parent) => !objects.has(parent) && !haveSet.has(parent));
      if (cut) shallow.push(oid);
    }
  }
  const unshallow: string[] = [];
  for (const boundary of shallowRequest) {
    const object = store.get(boundary);
    if (object === undefined || object.type !== 'commit') continue;
    if (shallow.includes(boundary)) continue;
    const commit = parseCommit(object.data);
    const lifted = commit.parents.every((parent) => objects.has(parent) || haveSet.has(parent));
    if (lifted && commit.parents.length > 0) unshallow.push(boundary);
  }
  return { objects, shallow, unshallow };
}

/** True when `ancestor` is `descendant` itself or reachable from it by parent edges. */
export function isAncestor(store: ReadonlyMap<string, GitObject>, ancestor: string, descendant: string): boolean {
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return false;
}

/** A common ancestor of two commits (nearest to `b` first), or null. */
export function mergeBase(store: ReadonlyMap<string, GitObject>, a: string, b: string): string | null {
  const ancestorsOfA = new Set<string>();
  const stack = [a];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (ancestorsOfA.has(oid)) continue;
    ancestorsOfA.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancestorsOfA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** Commit oids reachable from `tip`, newest first (parents in recorded order), deduplicated. */
export function historyFrom(store: ReadonlyMap<string, GitObject>, tip: string): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const object = store.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    seen.add(oid);
    order.push(oid);
    const parents = parseCommit(object.data).parents;
    for (let i = parents.length - 1; i >= 0; i -= 1) stack.push(parents[i] as string);
  }
  return order;
}

// ---------------------------------------------------------------- packfiles

function writePackObjectHeader(type: GitObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let value = size;
  let first = (TYPE_CODE[type] << 4) | (value & 0x0f);
  value = Math.floor(value / 16);
  if (value > 0) first |= 0x80;
  bytes.push(first);
  while (value > 0) {
    let byte = value & 0x7f;
    value = Math.floor(value / 128);
    if (value > 0) byte |= 0x80;
    bytes.push(byte);
  }
  return Buffer.from(bytes);
}

/** A version-2 pack of complete objects only (no deltas), with a correct SHA-1 trailer. */
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const object of list) {
    parts.push(writePackObjectHeader(object.type, object.data.length));
    parts.push(deflateSync(object.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

function readVarintSize(buffer: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buffer[start] as number;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let offset = start + 1;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
    if (shift > 63) throw new Error('pack entry size varint is too long');
  }
  return { size, next: offset, first };
}

function readOfsDeltaBase(buffer: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buffer[start] as number;
  let offset = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buffer[offset] as number;
    offset += 1;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: offset };
}

function inflateAt(buffer: Buffer, offset: number): { data: Buffer; next: number } {
  const view = buffer.subarray(offset);
  const result = inflateSync(view, { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
  const written = result.engine.bytesWritten;
  if (!written || written <= 0) throw new Error(`zlib stream at offset ${offset} consumed no bytes`);
  return { data: result.buffer, next: offset + written };
}

/** Apply a git delta (copy/insert instruction stream) to a base object's bytes. */
export function applyDelta(base: Uint8Array, delta: Uint8Array): Buffer {
  const baseBuffer = Buffer.from(base);
  const deltaBuffer = Buffer.from(delta);
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = deltaBuffer[offset] as number;
      offset += 1;
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== baseBuffer.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < deltaBuffer.length) {
    const op = deltaBuffer[offset] as number;
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset += (deltaBuffer[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) {
          copySize += (deltaBuffer[offset] as number) * 2 ** shift;
          offset += 1;
        }
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      baseBuffer.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      deltaBuffer.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0 is invalid');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

interface PendingDelta {
  readonly kind: 'ofs' | 'ref';
  readonly baseOffset: number;
  readonly baseOid: string;
  readonly delta: Buffer;
  readonly entryOffset: number;
}

/**
 * Parse a pack into an oid -> object map. Complete objects are resolved at once;
 * OFS/REF deltas (never sent by the suite's client, but valid git) are resolved
 * against the pack itself and, for REF deltas, an optional external base lookup.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  const expected = createHash('sha1').update(pack.subarray(0, trailerStart)).digest();
  if (!expected.equals(pack.subarray(trailerStart))) throw new Error('pack checksum mismatch');
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  const pending: PendingDelta[] = [];
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    const { next, first } = readVarintSize(pack, offset);
    const code = (first >> 4) & 0x07;
    offset = next;
    if (code === 6) {
      const base = readOfsDeltaBase(pack, offset);
      offset = base.next;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ kind: 'ofs', baseOffset: entryOffset - base.baseOffset, baseOid: '', delta: inflated.data, entryOffset });
    } else if (code === 7) {
      const baseOid = pack.toString('hex', offset, offset + 20);
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ kind: 'ref', baseOffset: 0, baseOid, delta: inflated.data, entryOffset });
    } else {
      const type = CODE_TYPE[code];
      if (type === undefined) throw new Error(`unknown pack object type code ${code}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      const object: GitObject = { type, data: inflated.data };
      objects.set(hashObject(type, inflated.data), object);
      byOffset.set(entryOffset, object);
    }
  }
  let remaining = pending;
  let guard = 0;
  while (remaining.length > 0 && guard < 1000) {
    guard += 1;
    const nextRound: PendingDelta[] = [];
    for (const delta of remaining) {
      const base = delta.kind === 'ofs' ? byOffset.get(delta.baseOffset) : (objects.get(delta.baseOid) ?? resolveBase?.(delta.baseOid));
      if (base === undefined) {
        nextRound.push(delta);
        continue;
      }
      const data = applyDelta(base.data, delta.delta);
      const object: GitObject = { type: base.type, data };
      objects.set(hashObject(base.type, data), object);
      byOffset.set(delta.entryOffset, object);
    }
    if (nextRound.length === remaining.length) throw new Error('pack delta base is missing');
    remaining = nextRound;
  }
  if (remaining.length > 0) throw new Error('pack delta base is missing');
  return objects;
}

// ---------------------------------------------------------------- pkt-lines

export function pktLine(payload: string | Uint8Array): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : Buffer.from(payload);
  const length = body.length + 4;
  if (length > 65520) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, body]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type PktPacket =
  | { readonly kind: 'data'; readonly payload: Buffer }
  | { readonly kind: 'flush' }
  | { readonly kind: 'delim' }
  | { readonly kind: 'response-end' };

/** Decode every complete packet in `buffer`; returns the packets and the unconsumed tail. */
export function decodePktLines(buffer: Buffer): { packets: PktPacket[]; rest: Buffer } {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const hex = buffer.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new Error('invalid pkt-line length');
    const length = parseInt(hex, 16);
    if (length === 0) {
      packets.push({ kind: 'flush' });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim' });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: 'response-end' });
      offset += 4;
    } else if (length === 3) {
      throw new Error('invalid pkt-line length 3');
    } else {
      if (offset + length > buffer.length) break;
      packets.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return { packets, rest: buffer.subarray(offset) };
}

/** One text line from a packet payload: strips at most one trailing LF (and a CR before it). */
export function pktText(payload: Buffer): string {
  let text = payload.toString('utf8');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  if (text.endsWith('\r')) text = text.slice(0, -1);
  return text;
}

/** Split a byte stream into sideband packets: band-1 payloads are chunked to fit the pkt-line limit. */
export function sidebandPackets(data: Buffer, band = 1): Buffer[] {
  const packets: Buffer[] = [];
  const CHUNK = 65515;
  for (let offset = 0; offset < data.length; offset += CHUNK) {
    const slice = data.subarray(offset, Math.min(data.length, offset + CHUNK));
    packets.push(pktLine(Buffer.concat([Buffer.from([band]), slice])));
  }
  return packets;
}
