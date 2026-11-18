// store.ts — the forge's single store: repositories (git objects + refs) and the
// issue / pull-request / label data every surface (REST, GraphQL, MCP, git) shares.
// State lives in memory: a trial is one process with a fresh store, and the bench
// workloads (2,000 sequential reads, 605 writes) are latency-bound.

import {
  buildCommit,
  buildTree,
  hashObject,
  historyFrom,
  isAncestor,
  makeObject,
  mergeBase,
  parseCommit,
  parseTree,
  peelToCommit,
  type GitObject,
  type TreeEntry,
} from './git.ts';

export class ForgeError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

export interface CommentRec {
  readonly dbId: number;
  readonly body: string;
  readonly authorLogin: string;
  readonly createdAt: string;
}

export interface IssueRec {
  readonly dbId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentRec[];
  readonly createdSeq: number;
}

export interface PullRec {
  readonly dbId: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  readonly head: string;
  readonly base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly createdSeq: number;
}

export interface RepoRec {
  readonly id: number;
  owner: string | null; // bound from the first owner-named path that resolves this repo
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly objects: Map<string, GitObject>;
  readonly refs: Map<string, string>;
  readonly labels: Map<string, { name: string; color: string }>;
  readonly issues: Map<number, IssueRec>;
  readonly pulls: Map<number, PullRec>;
  nextNumber: number; // one shared issue/PR sequence, as on GitHub
  readonly createdSeq: number;
}

export interface ForgeState {
  readonly repos: RepoRec[];
  learnedLogin: string | null;
  nextRepoId: number;
  nextDbId: number;
  seq: number;
}

export const state: ForgeState = {
  repos: [],
  learnedLogin: null,
  nextRepoId: 1,
  nextDbId: 1,
  seq: 0,
};

function nextSeq(): number {
  state.seq += 1;
  return state.seq;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function identFor(login: string | null): string {
  const who = login ?? 'forge';
  const epoch = Math.floor(Date.now() / 1000);
  return `${who} <${who}@example.invalid> ${epoch} +0000`;
}

/** The login paths and payloads should attribute to the token owner. */
export function viewerLogin(fallback = 'forge'): string {
  return state.learnedLogin ?? fallback;
}

// ---------------------------------------------------------------- repositories

export function createRepo(fields: { name: string; description?: string; isPrivate?: boolean; owner?: string | null }): RepoRec {
  const existing = state.repos.find((repo) => repo.name === fields.name);
  if (existing !== undefined) throw new ForgeError(422, 'name already exists');
  const repo: RepoRec = {
    id: state.nextRepoId,
    owner: fields.owner ?? state.learnedLogin,
    name: fields.name,
    description: fields.description ?? '',
    isPrivate: fields.isPrivate ?? false,
    defaultBranch: 'main',
    objects: new Map(),
    refs: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    createdSeq: nextSeq(),
  };
  state.nextRepoId += 1;
  state.repos.push(repo);
  return repo;
}

export function deleteRepo(repo: RepoRec): void {
  const index = state.repos.indexOf(repo);
  if (index >= 0) state.repos.splice(index, 1);
}

/**
 * Resolve a repo from an owner-named path. The forge serves one account (the
 * token's); a repo created through /user/repos is bound to the first owner
 * segment that resolves it, which is how the token owner's login is learned.
 * A name that exists under a different bound owner is a 404, never a 403.
 */
export function repoByPath(ownerSegment: string, name: string): RepoRec | null {
  for (const repo of state.repos) {
    if (repo.name === name && repo.owner === ownerSegment) {
      state.learnedLogin = ownerSegment;
      return repo;
    }
  }
  for (const repo of state.repos) {
    if (repo.name === name && repo.owner === null) {
      repo.owner = ownerSegment;
      state.learnedLogin = ownerSegment;
      return repo;
    }
  }
  return null;
}

/** Resolve by name alone (MCP tools, /user/repos duplicate checks). */
export function repoByName(name: string): RepoRec | null {
  return state.repos.find((repo) => repo.name === name) ?? null;
}

export function repoOwnerLogin(repo: RepoRec): string {
  return repo.owner ?? state.learnedLogin ?? 'forge';
}

// ---------------------------------------------------------------- git plumbing on a repo

export function storeObject(repo: RepoRec, type: GitObject['type'], data: Buffer): string {
  const { oid, object } = makeObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, object);
  return oid;
}

export function branchRef(branch: string): string {
  return branch.startsWith('refs/') ? branch : `refs/heads/${branch}`;
}

export function refTip(repo: RepoRec, ref: string): string | null {
  return repo.refs.get(ref) ?? null;
}

/** The commit oid a ref or branch name resolves to (peeling tags), or null. */
export function resolveCommit(repo: RepoRec, refOrBranchOrSha: string): string | null {
  const byRef = repo.refs.get(branchRef(refOrBranchOrSha)) ?? repo.refs.get(refOrBranchOrSha);
  if (byRef !== undefined) return peelToCommit(repo.objects, byRef);
  if (/^[0-9a-f]{40}$/.test(refOrBranchOrSha) && repo.objects.has(refOrBranchOrSha)) {
    return peelToCommit(repo.objects, refOrBranchOrSha);
  }
  return null;
}

/** Flatten a commit's tree to path -> blob oid (files only). */
export function flattenTree(repo: RepoRec, commitOid: string): Map<string, string> {
  const out = new Map<string, string>();
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== 'commit') return out;
  const walk = (treeOid: string, prefix: string): void => {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return;
    for (const entry of parseTree(tree.data)) {
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, `${prefix}${entry.name}/`);
      else if (entry.mode !== '160000') out.set(`${prefix}${entry.name}`, entry.oid);
    }
  };
  walk(parseCommit(commit.data).tree, '');
  return out;
}

/** Build (and store) nested trees from a flat path -> blob oid map; returns the root tree oid. */
export function buildTreeFromFlat(repo: RepoRec, flat: ReadonlyMap<string, string>): string {
  interface Node {
    files: Map<string, string>;
    dirs: Map<string, Node>;
  }
  const root: Node = { files: new Map(), dirs: new Map() };
  for (const [path, oid] of flat) {
    const parts = path.split('/');
    let node = root;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const part = parts[i] as string;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: new Map(), dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.set(parts[parts.length - 1] as string, oid);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, oid] of node.files) entries.push({ mode: '100644', name, oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return storeObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create and store a commit; returns its oid. */
export function createCommit(
  repo: RepoRec,
  fields: { tree: string; parents: readonly string[]; message: string; login?: string | null },
): string {
  const ident = identFor(fields.login ?? repoOwnerLogin(repo));
  const data = buildCommit({ tree: fields.tree, parents: fields.parents, author: ident, committer: ident, message: fields.message });
  return storeObject(repo, 'commit', data);
}

/** One contents-style commit on a branch: apply `mutate` to the branch's flat tree, commit, move the ref. */
export function commitTreeChange(
  repo: RepoRec,
  branch: string,
  message: string,
  mutate: (flat: Map<string, string>) => void,
): string {
  const ref = branchRef(branch);
  const tip = refTip(repo, ref);
  const tipCommit = tip === null ? null : peelToCommit(repo.objects, tip);
  const flat = tipCommit === null ? new Map<string, string>() : flattenTree(repo, tipCommit);
  mutate(flat);
  const tree = buildTreeFromFlat(repo, flat);
  const commit = createCommit(repo, { tree, parents: tipCommit === null ? [] : [tipCommit], message });
  repo.refs.set(ref, commit);
  return commit;
}

// ---------------------------------------------------------------- contents

export interface FileHit {
  readonly kind: 'file';
  readonly blobOid: string;
  readonly data: Buffer;
  readonly size: number;
}
export interface DirHit {
  readonly kind: 'dir';
  readonly entries: ReadonlyArray<{ name: string; path: string; type: 'file' | 'dir'; sha: string }>;
}
export type ContentHit = FileHit | DirHit;

export function readContents(repo: RepoRec, refName: string, path: string): ContentHit | null {
  const commit = resolveCommit(repo, refName);
  if (commit === null) return null;
  const commitObject = repo.objects.get(commit);
  if (commitObject === undefined) return null;
  let treeOid = parseCommit(commitObject.data).tree;
  const clean = path.replace(/^\/+|\/+$/g, '');
  if (clean === '') {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined) return null;
    return {
      kind: 'dir',
      entries: parseTree(tree.data).map((entry) => ({
        name: entry.name,
        path: entry.name,
        type: entry.mode === '40000' || entry.mode === '040000' ? 'dir' as const : 'file' as const,
        sha: entry.oid,
      })),
    };
  }
  const parts = clean.split('/');
  for (let i = 0; i < parts.length; i += 1) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === parts[i]);
    if (entry === undefined) return null;
    if (i === parts.length - 1) {
      if (entry.mode === '40000' || entry.mode === '040000') {
        const dirTree = repo.objects.get(entry.oid);
        if (dirTree === undefined) return null;
        return {
          kind: 'dir',
          entries: parseTree(dirTree.data).map((child) => ({
            name: child.name,
            path: `${clean}/${child.name}`,
            type: child.mode === '40000' || child.mode === '040000' ? 'dir' as const : 'file' as const,
            sha: child.oid,
          })),
        };
      }
      const blob = repo.objects.get(entry.oid);
      if (blob === undefined) return null;
      return { kind: 'file', blobOid: entry.oid, data: blob.data, size: blob.data.length };
    }
    if (entry.mode !== '40000' && entry.mode !== '040000') return null;
    treeOid = entry.oid;
  }
  return null;
}

export function blobShaAt(repo: RepoRec, branch: string, path: string): string | null {
  const hit = readContents(repo, branch, path);
  return hit !== null && hit.kind === 'file' ? hit.blobOid : null;
}

// ---------------------------------------------------------------- issues

export function createIssue(
  repo: RepoRec,
  fields: { title: string; body?: string; labels?: readonly string[] },
): IssueRec {
  const labels = fields.labels ?? [];
  for (const label of labels) {
    if (!repo.labels.has(label)) throw new ForgeError(422, `label "${label}" does not exist in this repository`);
  }
  const issue: IssueRec = {
    dbId: state.nextDbId,
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    labels: [...labels],
    comments: [],
    createdSeq: nextSeq(),
  };
  state.nextDbId += 1;
  repo.nextNumber += 1;
  repo.issues.set(issue.number, issue);
  return issue;
}

export function addComment(target: { comments: CommentRec[] }, body: string, login: string): CommentRec {
  const comment: CommentRec = { dbId: state.nextDbId, body, authorLogin: login, createdAt: nowIso() };
  state.nextDbId += 1;
  target.comments.push(comment);
  return comment;
}

// ---------------------------------------------------------------- pull requests and merging

export function createPull(
  repo: RepoRec,
  fields: { title: string; body?: string; head: string; base: string },
): PullRec {
  const headTip = resolveCommit(repo, fields.head);
  if (headTip === null) throw new ForgeError(422, `head branch "${fields.head}" does not exist`);
  const baseTip = resolveCommit(repo, fields.base);
  if (baseTip === null) throw new ForgeError(422, `base branch "${fields.base}" does not exist`);
  const pull: PullRec = {
    dbId: state.nextDbId,
    number: repo.nextNumber,
    title: fields.title,
    body: fields.body ?? '',
    state: 'open',
    head: fields.head,
    base: fields.base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdSeq: nextSeq(),
  };
  state.nextDbId += 1;
  repo.nextNumber += 1;
  repo.pulls.set(pull.number, pull);
  return pull;
}

export interface MergeOutcome {
  readonly sha: string;
}

/**
 * A real three-way squash merge: the merged tree (merge-base vs head vs current
 * base) becomes one new commit on the base branch. A path both sides changed
 * differently since the merge base is a conflict (ForgeError 405).
 */
export function mergePull(repo: RepoRec, pull: PullRec): MergeOutcome {
  if (pull.merged) throw new ForgeError(405, 'Pull Request has already been merged');
  if (pull.state !== 'open') throw new ForgeError(405, 'Pull Request is not open');
  const headTip = resolveCommit(repo, pull.head);
  const baseTip = resolveCommit(repo, pull.base);
  if (headTip === null || baseTip === null) throw new ForgeError(405, 'Pull Request branch is missing');
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const baseFlat = flattenTree(repo, base);
  const headFlat = flattenTree(repo, headTip);
  const nowFlat = flattenTree(repo, baseTip);
  const merged = new Map<string, string>();
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...nowFlat.keys()]);
  for (const path of paths) {
    const baseValue = baseFlat.get(path);
    const headValue = headFlat.get(path);
    const nowValue = nowFlat.get(path);
    let chosen: string | undefined;
    if (headValue === nowValue) chosen = headValue;
    else if (baseValue === headValue) chosen = nowValue;
    else if (baseValue === nowValue) chosen = headValue;
    else throw new ForgeError(405, `Merge conflict in ${path}`);
    if (chosen !== undefined) merged.set(path, chosen);
  }
  const tree = buildTreeFromFlat(repo, merged);
  const sha = createCommit(repo, {
    tree,
    parents: [baseTip],
    message: `${pull.title} (#${pull.number})`,
  });
  repo.refs.set(branchRef(pull.base), sha);
  pull.merged = true;
  pull.state = 'closed';
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = sha;
  return { sha };
}

/** Whether the PR would merge cleanly right now (GraphQL `mergeable`). */
export function pullMergeable(repo: RepoRec, pull: PullRec): 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' {
  if (pull.merged) return 'UNKNOWN';
  const headTip = resolveCommit(repo, pull.head);
  const baseTip = resolveCommit(repo, pull.base);
  if (headTip === null || baseTip === null) return 'UNKNOWN';
  if (isAncestor(repo.objects, headTip, baseTip)) return 'UNKNOWN';
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const baseFlat = flattenTree(repo, base);
  const headFlat = flattenTree(repo, headTip);
  const nowFlat = flattenTree(repo, baseTip);
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys(), ...nowFlat.keys()]);
  for (const path of paths) {
    const baseValue = baseFlat.get(path);
    const headValue = headFlat.get(path);
    const nowValue = nowFlat.get(path);
    if (headValue === nowValue || baseValue === headValue || baseValue === nowValue) continue;
    return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

export interface PullFile {
  readonly filename: string;
  readonly status: 'added' | 'removed' | 'modified';
  readonly additions: number;
  readonly deletions: number;
  readonly changes: number;
}

function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  // Small LCS over lines; PR files in scope are tiny.
  const m = oldLines.length;
  const n = newLines.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = oldLines[i] === newLines[j] ? (dp[i + 1][j + 1] as number) + 1 : Math.max(dp[i + 1][j] as number, dp[i][j + 1] as number);
    }
  }
  const common = dp[0][0] as number;
  return { additions: n - common, deletions: m - common };
}

/** The path-level diff of a PR: merge-base tree vs head tree, as GitHub's files view reports it. */
export function pullFiles(repo: RepoRec, pull: PullRec): PullFile[] {
  const headTip = resolveCommit(repo, pull.head);
  const baseTip = resolveCommit(repo, pull.base);
  if (headTip === null || baseTip === null) return [];
  const base = mergeBase(repo.objects, baseTip, headTip) ?? baseTip;
  const baseFlat = flattenTree(repo, base);
  const headFlat = flattenTree(repo, headTip);
  const files: PullFile[] = [];
  const paths = new Set<string>([...baseFlat.keys(), ...headFlat.keys()]);
  for (const path of [...paths].sort()) {
    const oldOid = baseFlat.get(path);
    const newOid = headFlat.get(path);
    if (oldOid === newOid) continue;
    const oldText = oldOid === undefined ? '' : (repo.objects.get(oldOid)?.data.toString('utf8') ?? '');
    const newText = newOid === undefined ? '' : (repo.objects.get(newOid)?.data.toString('utf8') ?? '');
    const { additions, deletions } = lineDiff(oldText, newText);
    files.push({
      filename: path,
      status: oldOid === undefined ? 'added' : newOid === undefined ? 'removed' : 'modified',
      additions,
      deletions,
      changes: additions + deletions,
    });
  }
  return files;
}

export function commitList(repo: RepoRec, refName: string): Array<{ sha: string; message: string; tree: string; parents: string[] }> {
  const tip = resolveCommit(repo, refName);
  if (tip === null) return [];
  return historyFrom(repo.objects, tip).map((sha) => {
    const commit = parseCommit((repo.objects.get(sha) as GitObject).data);
    return { sha, message: commit.message.replace(/\n$/, ''), tree: commit.tree, parents: [...commit.parents] };
  });
}
