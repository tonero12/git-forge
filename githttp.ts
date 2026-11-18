// githttp.ts — git smart HTTP: info/refs advertisements (v0 and v2), ls-refs,
// fetch (protocol v0 and v2, with shallow/deepen) and receive-pack with
// report-status, all against the in-memory object store. No git binary exists
// in the trial; this is the whole protocol, implemented from the spec.

import {
  collectToSend,
  decodePktLines,
  isAncestor,
  parseTag,
  pktDelim,
  pktFlush,
  pktLine,
  pktText,
  readPack,
  sidebandPackets,
  writePack,
  ZERO_OID,
  type GitObject,
  type PktPacket,
} from './git.ts';
import { refTip, repoByPath, type RepoRec } from './store.ts';

export interface HttpResult {
  readonly status: number;
  readonly contentType: string;
  readonly body: Buffer;
}

const AGENT = 'agent=forge/1.0';

function sortedRefs(repo: RepoRec): Array<[string, string]> {
  return [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
}

function headTarget(repo: RepoRec): string {
  return `refs/heads/${repo.defaultBranch}`;
}

function peeledOf(repo: RepoRec, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTag(object.data).object;
}

// ---------------------------------------------------------------- advertisements

function v0Advertisement(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? ['side-band-64k', 'ofs-delta', 'shallow', AGENT, `symref=HEAD:${headTarget(repo)}`]
      : ['report-status', 'side-band-64k', 'delete-refs', 'ofs-delta', AGENT, `symref=HEAD:${headTarget(repo)}`];
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush()];
  const refs = sortedRefs(repo);
  const headOid = refTip(repo, headTarget(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps.join(' ')}\n`));
  } else {
    let first = true;
    const emit = (line: string): void => {
      if (first) {
        parts.push(pktLine(`${line}\0${caps.join(' ')}\n`));
        first = false;
      } else {
        parts.push(pktLine(`${line}\n`));
      }
    };
    emit(`${headOid} HEAD`);
    for (const [ref, oid] of refs) {
      emit(`${oid} ${ref}`);
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function v2Advertisement(): Buffer {
  const lines = ['version 2', AGENT, 'object-format=sha1', 'ls-refs=unborn', 'fetch=shallow'];
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
}

export function infoRefs(repo: RepoRec, service: 'git-upload-pack' | 'git-receive-pack', gitProtocol: string | null): HttpResult {
  const contentType = `application/x-${service}-advertisement`;
  const wantsV2 = service === 'git-upload-pack' && gitProtocol !== null && gitProtocol.split(',').map((part) => part.trim()).includes('version=2');
  if (wantsV2) {
    return { status: 200, contentType, body: v2Advertisement() };
  }
  return { status: 200, contentType, body: v0Advertisement(repo, service) };
}

// ---------------------------------------------------------------- ls-refs (v2)

function lsRefs(repo: RepoRec, args: readonly string[]): Buffer {
  let peel = false;
  let symrefs = false;
  let unborn = false;
  const prefixes: string[] = [];
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const lines: string[] = [];
  const target = headTarget(repo);
  const headOid = refTip(repo, target);
  if (matches('HEAD')) {
    if (headOid !== null) {
      lines.push(`${headOid} HEAD${symrefs ? ` symref-target:${target}` : ''}`);
    } else if (unborn) {
      lines.push(`unborn HEAD${symrefs ? ` symref-target:${target}` : ''}`);
    }
  }
  for (const [ref, oid] of sortedRefs(repo)) {
    if (!matches(ref)) continue;
    let line = `${oid} ${ref}`;
    if (peel) {
      const peeled = peeledOf(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(line);
  }
  return Buffer.concat([...lines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
}

// ---------------------------------------------------------------- fetch

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
}

function computePack(repo: RepoRec, args: FetchArgs): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const result = collectToSend(repo.objects, args.wants, args.haves, args.shallow, args.depth);
  return { pack: writePack(result.objects.values()), shallow: result.shallow, unshallow: result.unshallow };
}

function fetchV2(repo: RepoRec, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = computePack(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation round (the client has not sent `done`): acknowledgments only.
    // Once `done` is sent, real git expects the packfile section directly.
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktDelim());
    parts.push(pktFlush());
    return Buffer.concat(parts);
  }
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

function fetchV0(repo: RepoRec, args: FetchArgs): Buffer {
  const { pack, shallow, unshallow } = computePack(repo, args);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPackets(pack, 1)) parts.push(packet);
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- request dispatch

function packetTexts(packets: readonly PktPacket[]): string[] {
  const texts: string[] = [];
  for (const packet of packets) {
    if (packet.kind === 'data') texts.push(pktText(packet.payload));
  }
  return texts;
}

export function uploadPack(repo: RepoRec, body: Buffer, gitProtocol: string | null): HttpResult {
  const contentType = 'application/x-git-upload-pack-result';
  let decoded: { packets: PktPacket[]; rest: Buffer };
  try {
    decoded = decodePktLines(body);
  } catch {
    return { status: 400, contentType: 'text/plain', body: Buffer.from('invalid pkt-line request\n') };
  }
  const { packets } = decoded;
  const firstData = packets.find((packet) => packet.kind === 'data');
  const firstText = firstData !== undefined && firstData.kind === 'data' ? pktText(firstData.payload) : '';

  if (firstText.startsWith('command=')) {
    // Protocol v2: command header lines, a delim, then argument lines, then flush.
    const command = firstText.slice('command='.length);
    const delimIndex = packets.findIndex((packet) => packet.kind === 'delim');
    const argPackets = delimIndex === -1 ? [] : packets.slice(delimIndex + 1);
    const args = packetTexts(argPackets);
    if (command === 'ls-refs') {
      return { status: 200, contentType, body: lsRefs(repo, args) };
    }
    if (command === 'fetch') {
      const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
      for (const arg of args) {
        if (arg.startsWith('want ')) fetchArgs.wants.push(arg.slice(5).trim());
        else if (arg.startsWith('have ')) fetchArgs.haves.push(arg.slice(5).trim());
        else if (arg.startsWith('shallow ')) fetchArgs.shallow.push(arg.slice(8).trim());
        else if (arg.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(arg.slice(7).trim(), 10);
        else if (arg === 'done') fetchArgs.done = true;
      }
      return { status: 200, contentType, body: fetchV2(repo, fetchArgs) };
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from(`unknown command ${command}\n`) };
  }

  if (firstText.startsWith('want ') || firstText === '') {
    // Protocol v0: want section, flush, have section, flush.
    const fetchArgs: FetchArgs = { wants: [], haves: [], shallow: [], depth: undefined, done: true };
    let section: 'want' | 'have' = 'want';
    for (const packet of packets) {
      if (packet.kind === 'flush') {
        section = 'have';
        continue;
      }
      if (packet.kind !== 'data') continue;
      const line = pktText(packet.payload);
      if (section === 'want') {
        if (line.startsWith('want ')) fetchArgs.wants.push(line.slice(5).trim().split(' ')[0] as string);
        else if (line.startsWith('shallow ')) fetchArgs.shallow.push(line.slice(8).trim());
        else if (line.startsWith('deepen ')) fetchArgs.depth = Number.parseInt(line.slice(7).trim(), 10);
      } else if (line.startsWith('have ')) {
        fetchArgs.haves.push(line.slice(5).trim());
      }
    }
    void gitProtocol;
    return { status: 200, contentType, body: fetchV0(repo, fetchArgs) };
  }

  return { status: 400, contentType: 'text/plain', body: Buffer.from('unrecognised upload-pack request\n') };
}

// ---------------------------------------------------------------- receive-pack

interface RefCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

export function receivePack(repo: RepoRec, body: Buffer): HttpResult {
  const contentType = 'application/x-git-receive-pack-result';
  // Parse the pkt-line command list; whatever follows the terminating flush is the pack.
  const commands: RefCommand[] = [];
  let offset = 0;
  let packStart = -1;
  try {
    while (offset + 4 <= body.length) {
      const hex = body.toString('ascii', offset, offset + 4);
      if (!/^[0-9a-fA-F]{4}$/.test(hex)) break;
      const length = parseInt(hex, 16);
      if (length === 0) {
        packStart = offset + 4;
        break;
      }
      if (length < 4 || offset + length > body.length) break;
      let line = pktText(body.subarray(offset + 4, offset + length));
      const nul = line.indexOf('\0');
      if (nul !== -1) line = line.slice(0, nul);
      const parts = line.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
      offset += length;
    }
  } catch {
    // fall through: no commands parsed
  }

  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packStart !== -1 && packStart < body.length) {
    const packBytes = body.subarray(packStart);
    if (packBytes.length >= 4 && packBytes.toString('ascii', 0, 4) === 'PACK') {
      try {
        const objects = readPack(packBytes, (oid) => repo.objects.get(oid));
        for (const [oid, object] of objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, object as GitObject);
        }
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'error';
      }
    }
  }

  const reportLines: string[] = [`unpack ${unpackDetail}`];
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    reportLines.push(applyRefCommand(repo, command));
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(`${line}\n`)), pktFlush()]);
  const outer = Buffer.concat([...sidebandPackets(inner, 1), pktFlush()]);
  return { status: 200, contentType, body: outer };
}

function applyRefCommand(repo: RepoRec, command: RefCommand): string {
  const { oldOid, newOid, ref } = command;
  const current = repo.refs.get(ref) ?? ZERO_OID;
  if (newOid === ZERO_OID) {
    // Delete.
    if (current === ZERO_OID) return `ng ${ref} reference not found`;
    if (oldOid !== ZERO_OID && oldOid !== current) return `ng ${ref} non-fast-forward`;
    repo.refs.delete(ref);
    return `ok ${ref}`;
  }
  if (!repo.objects.has(newOid)) return `ng ${ref} missing object`;
  if (oldOid === ZERO_OID) {
    // Create.
    if (current !== ZERO_OID) return `ng ${ref} reference already exists`;
    repo.refs.set(ref, newOid);
    return `ok ${ref}`;
  }
  if (oldOid !== current) return `ng ${ref} non-fast-forward`;
  if (oldOid === newOid) return `ok ${ref}`;
  const newCommit = repo.objects.get(newOid);
  const oldCommit = repo.objects.get(oldOid);
  if (newCommit !== undefined && oldCommit !== undefined && newCommit.type === 'commit' && oldCommit.type === 'commit') {
    if (!isAncestor(repo.objects, oldOid, newOid)) return `ng ${ref} non-fast-forward`;
  }
  repo.refs.set(ref, newOid);
  return `ok ${ref}`;
}

// ---------------------------------------------------------------- routing

export function gitRoute(owner: string, repoName: string, tail: string, method: string, query: URLSearchParams, body: Buffer, gitProtocol: string | null): HttpResult {
  const repo = repoByPath(owner, repoName);
  if (repo === null) {
    return { status: 404, contentType: 'text/plain', body: Buffer.from('repository not found\n') };
  }
  if (method === 'GET' && tail === '/info/refs') {
    const service = query.get('service');
    if (service === 'git-upload-pack' || service === 'git-receive-pack') {
      return infoRefs(repo, service, gitProtocol);
    }
    return { status: 400, contentType: 'text/plain', body: Buffer.from('missing service\n') };
  }
  if (method === 'POST' && tail === '/git-upload-pack') return uploadPack(repo, body, gitProtocol);
  if (method === 'POST' && tail === '/git-receive-pack') return receivePack(repo, body);
  return { status: 404, contentType: 'text/plain', body: Buffer.from('not found\n') };
}
