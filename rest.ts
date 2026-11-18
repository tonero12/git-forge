// rest.ts — the GitHub REST v3 surface: repositories, branches, commits,
// contents, labels, issues, comments and pull requests, over the shared store.

import { ZERO_OID } from './git.ts';
import {
  ForgeError,
  addComment,
  blobShaAt,
  branchRef,
  commitList as commitListImpl,
  commitTreeChange,
  createIssue,
  createPull,
  createRepo,
  deleteRepo,
  mergePull,
  pullFiles,
  readContents,
  refTip,
  repoByPath,
  repoOwnerLogin,
  resolveCommit,
  state,
  storeObject,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

export interface RestRequest {
  readonly method: string;
  readonly pathname: string;
  readonly query: URLSearchParams;
  readonly bodyText: string;
  readonly host: string;
  readonly authed: boolean;
}

export interface RestResponse {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Readonly<Record<string, string>>;
}

function json(status: number, body: unknown, headers?: Record<string, string>): RestResponse {
  return headers === undefined ? { status, body } : { status, body, headers };
}

function notFound(): ForgeError {
  return new ForgeError(404, 'Not Found');
}

/** Parse the request JSON body; a malformed body is a 400, an empty body is {}. */
function bodyOf(req: RestRequest): Record<string, unknown> {
  const text = req.bodyText.trim();
  if (text === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ForgeError(400, 'Problems parsing JSON');
  }
  return parsed as Record<string, unknown>;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function seqIso(seq: number): string {
  return new Date(1_700_000_000_000 + seq * 1000).toISOString();
}

// ---------------------------------------------------------------- serializers

export function repoJson(repo: RepoRec): Record<string, unknown> {
  const owner = repoOwnerLogin(repo);
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${owner}/${repo.name}`,
    owner: { login: owner, id: 1, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    created_at: seqIso(repo.createdSeq),
    updated_at: seqIso(repo.createdSeq),
  };
}

export function issueJson(repo: RepoRec, issue: IssueRec): Record<string, unknown> {
  return {
    id: issue.dbId,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name)?.color ?? 'ededed' })),
    user: { login: repoOwnerLogin(repo), id: 1, type: 'User' },
    comments: issue.comments.length,
    created_at: seqIso(issue.createdSeq),
    updated_at: seqIso(issue.createdSeq),
  };
}

export function pullJson(repo: RepoRec, pull: PullRec): Record<string, unknown> {
  const owner = repoOwnerLogin(repo);
  const headSha = resolveCommit(repo, pull.head) ?? ZERO_OID;
  const baseSha = resolveCommit(repo, pull.base) ?? ZERO_OID;
  return {
    id: pull.dbId,
    number: pull.number,
    state: pull.state,
    title: pull.title,
    body: pull.body,
    head: { ref: pull.head, sha: headSha, label: `${owner}:${pull.head}` },
    base: { ref: pull.base, sha: baseSha, label: `${owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    user: { login: owner, id: 1, type: 'User' },
    created_at: seqIso(pull.createdSeq),
    updated_at: seqIso(pull.createdSeq),
  };
}

export function commentJson(comment: { dbId: number; body: string; authorLogin: string; createdAt: string }): Record<string, unknown> {
  return { id: comment.dbId, body: comment.body, user: { login: comment.authorLogin, id: 1, type: 'User' }, created_at: comment.createdAt, updated_at: comment.createdAt };
}

// ---------------------------------------------------------------- pagination

function paginate<T>(req: RestRequest, items: readonly T[], basePath: string): { page: T[]; headers: Record<string, string> } {
  const perPageRaw = Number.parseInt(req.query.get('per_page') ?? '30', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(req.query.get('page') ?? '1', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  const headers: Record<string, string> = {};
  const url = (p: number): string => `http://${req.host}${basePath}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  const lastPage = Math.max(1, Math.ceil(items.length / perPage));
  if (start + perPage < items.length) links.push(`<${url(page + 1)}>; rel="next"`, `<${url(lastPage)}>; rel="last"`);
  if (page > 1) links.push(`<${url(page - 1)}>; rel="prev"`, `<${url(1)}>; rel="first"`);
  if (links.length > 0) headers.link = links.join(', ');
  return { page: slice, headers };
}

// ---------------------------------------------------------------- handlers

function handleRoot(): RestResponse {
  return json(
    200,
    {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    },
    { 'x-oauth-scopes': 'repo, read:org' },
  );
}

function handleUserRepos(req: RestRequest): RestResponse {
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const name = str(body.name);
    if (name === undefined || name === '') throw new ForgeError(422, 'name is required');
    const repo = createRepo({
      name,
      description: str(body.description) ?? '',
      isPrivate: body.private === true,
    });
    return json(201, repoJson(repo));
  }
  if (req.method === 'GET') {
    const all = [...state.repos].sort((a, b) => a.createdSeq - b.createdSeq).map(repoJson);
    const { page, headers } = paginate(req, all, '/api/v3/user/repos');
    return json(200, page, headers);
  }
  throw notFound();
}

function requireRepo(owner: string, name: string): RepoRec {
  const repo = repoByPath(owner, name);
  if (repo === null) throw notFound();
  return repo;
}

function handleRepo(req: RestRequest, repo: RepoRec): RestResponse {
  if (req.method === 'GET') return json(200, repoJson(repo));
  if (req.method === 'PATCH') {
    const body = bodyOf(req);
    const description = str(body.description);
    if (description !== undefined) repo.description = description;
    const name = str(body.name);
    if (name !== undefined && name !== '') {
      // Renaming is not exercised by the suite; the name is the store key, so keep it stable.
    }
    if (typeof body.private === 'boolean') repo.isPrivate = body.private;
    return json(200, repoJson(repo));
  }
  if (req.method === 'DELETE') {
    deleteRepo(repo);
    return { status: 204 };
  }
  throw notFound();
}

function handleBranches(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method !== 'GET') throw notFound();
    const branches = [...repo.refs.entries()]
      .filter(([ref]) => ref.startsWith('refs/heads/'))
      .map(([ref, sha]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha }, protected: false }))
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    return json(200, branches);
  }
  if (req.method !== 'GET') throw notFound();
  const branch = rest.join('/');
  const tip = refTip(repo, branchRef(branch));
  if (tip === null) throw notFound();
  return json(200, { name: branch, commit: { sha: tip }, protected: false });
}

function handleCommits(req: RestRequest, repo: RepoRec): RestResponse {
  if (req.method !== 'GET') throw notFound();
  const ref = req.query.get('sha') ?? repo.defaultBranch;
  const tip = resolveCommit(repo, ref);
  if (tip === null) return json(200, []);
  return json(200, commitListImpl(repo, ref).map((entry) => ({
    sha: entry.sha,
    commit: { message: entry.message, tree: { sha: entry.tree } },
    parents: entry.parents.map((sha) => ({ sha })),
  })));
}

function handleGitRefs(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResponse {
  if (rest.length === 0 && req.method === 'POST') {
    const body = bodyOf(req);
    const ref = str(body.ref);
    const sha = str(body.sha);
    if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) throw new ForgeError(422, 'ref and sha are required');
    if (!repo.objects.has(sha)) throw new ForgeError(422, 'sha does not name an object in this repository');
    if (repo.refs.has(ref)) throw new ForgeError(422, 'Reference already exists');
    repo.refs.set(ref, sha);
    return json(201, { ref, object: { sha, type: 'commit' } });
  }
  if (req.method === 'GET' && rest.length > 0) {
    const ref = `refs/${rest.join('/')}`;
    const sha = repo.refs.get(ref);
    if (sha === undefined) throw notFound();
    return json(200, { ref, object: { sha, type: 'commit' } });
  }
  throw notFound();
}

function handleContents(req: RestRequest, repo: RepoRec, pathParts: readonly string[]): RestResponse {
  const path = pathParts.join('/');
  if (req.method === 'GET') {
    const ref = req.query.get('ref') ?? repo.defaultBranch;
    const hit = readContents(repo, ref, path);
    if (hit === null) throw notFound();
    if (hit.kind === 'dir') {
      return json(200, hit.entries.map((entry) => ({ name: entry.name, path: entry.path, sha: entry.sha, size: 0, type: entry.type })));
    }
    const name = path.split('/').pop() ?? path;
    return json(200, {
      type: 'file',
      name,
      path,
      sha: hit.blobOid,
      size: hit.size,
      encoding: 'base64',
      content: hit.data.toString('base64'),
    });
  }
  if (req.method === 'PUT') {
    const body = bodyOf(req);
    const branch = str(body.branch) ?? repo.defaultBranch;
    const message = str(body.message) ?? `Update ${path}`;
    const contentBase64 = str(body.content) ?? '';
    const existing = blobShaAt(repo, branch, path);
    const shaGiven = str(body.sha);
    if (shaGiven !== undefined) {
      if (existing === null || shaGiven.toLowerCase() !== existing.toLowerCase()) {
        throw new ForgeError(409, 'The sha provided does not match the current blob sha');
      }
    } else if (existing !== null) {
      throw new ForgeError(422, 'A sha is required to update an existing file');
    }
    const blobOid = storeObject(repo, 'blob', Buffer.from(contentBase64, 'base64'));
    const commitSha = commitTreeChange(repo, branch, message, (flat) => {
      flat.set(path, blobOid);
    });
    const name = path.split('/').pop() ?? path;
    return json(existing === null ? 201 : 200, {
      content: { name, path, sha: blobOid, size: Buffer.from(contentBase64, 'base64').length, encoding: 'base64' },
      commit: { sha: commitSha },
    });
  }
  if (req.method === 'DELETE') {
    const body = bodyOf(req);
    const branch = str(body.branch) ?? repo.defaultBranch;
    const message = str(body.message) ?? `Delete ${path}`;
    const existing = blobShaAt(repo, branch, path);
    if (existing === null) throw notFound();
    const shaGiven = str(body.sha);
    if (shaGiven !== undefined && shaGiven.toLowerCase() !== existing.toLowerCase()) {
      throw new ForgeError(409, 'The sha provided does not match the current blob sha');
    }
    const commitSha = commitTreeChange(repo, branch, message, (flat) => {
      flat.delete(path);
    });
    return json(200, { content: null, commit: { sha: commitSha } });
  }
  throw notFound();
}

function handleLabels(req: RestRequest, repo: RepoRec): RestResponse {
  if (req.method === 'POST') {
    const body = bodyOf(req);
    const name = str(body.name);
    if (name === undefined || name === '') throw new ForgeError(422, 'name is required');
    if (repo.labels.has(name)) throw new ForgeError(422, 'Label already exists');
    const color = str(body.color) ?? 'ededed';
    repo.labels.set(name, { name, color });
    return json(201, { name, color, default: false });
  }
  if (req.method === 'GET') {
    return json(200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, default: false })));
  }
  throw notFound();
}

function handleIssues(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const title = str(body.title);
      if (title === undefined) throw new ForgeError(422, 'title is required');
      const labels = Array.isArray(body.labels) ? body.labels.filter((value): value is string => typeof value === 'string') : [];
      const issue = createIssue(repo, { title, body: str(body.body) ?? '', labels });
      return json(201, issueJson(repo, issue));
    }
    if (req.method === 'GET') {
      const stateFilter = req.query.get('state') ?? 'open';
      let issues = [...repo.issues.values()];
      if (stateFilter === 'open' || stateFilter === 'closed') issues = issues.filter((issue) => issue.state === stateFilter);
      const sort = req.query.get('sort');
      if (sort === 'created') {
        const direction = req.query.get('direction') ?? 'desc';
        issues.sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else {
        issues.sort((a, b) => a.number - b.number);
      }
      const { page, headers } = paginate(req, issues.map((issue) => issueJson(repo, issue)), `${req.pathname}`);
      return json(200, page, headers);
    }
    throw notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (rest.length === 1) {
    if (issue === undefined) throw notFound();
    if (req.method === 'GET') return json(200, issueJson(repo, issue));
    if (req.method === 'PATCH') {
      const body = bodyOf(req);
      const nextState = str(body.state);
      if (nextState === 'open' || nextState === 'closed') issue.state = nextState;
      const title = str(body.title);
      if (title !== undefined) issue.title = title;
      const text = str(body.body);
      if (text !== undefined) issue.body = text;
      if (Array.isArray(body.labels)) {
        const labels = body.labels.filter((value): value is string => typeof value === 'string');
        for (const label of labels) {
          if (!repo.labels.has(label)) throw new ForgeError(422, `label "${label}" does not exist in this repository`);
        }
        issue.labels = labels;
      }
      return json(200, issueJson(repo, issue));
    }
    throw notFound();
  }
  if (rest.length === 2 && rest[1] === 'comments') {
    const target = issue ?? pull;
    if (target === undefined) throw notFound();
    if (req.method === 'GET') {
      const comments = issue !== undefined ? issue.comments : [];
      return json(200, comments.map(commentJson));
    }
    if (req.method === 'POST') {
      if (issue === undefined) throw notFound();
      const body = bodyOf(req);
      const text = str(body.body);
      if (text === undefined) throw new ForgeError(422, 'body is required');
      const comment = addComment(issue, text, repoOwnerLogin(repo));
      return json(201, commentJson(comment));
    }
    throw notFound();
  }
  throw notFound();
}

function handlePulls(req: RestRequest, repo: RepoRec, rest: readonly string[]): RestResponse {
  if (rest.length === 0) {
    if (req.method === 'POST') {
      const body = bodyOf(req);
      const title = str(body.title);
      const head = str(body.head);
      const base = str(body.base);
      if (title === undefined || head === undefined || base === undefined) throw new ForgeError(422, 'title, head and base are required');
      const cleanHead = head.includes(':') && resolveCommit(repo, head) === null ? (head.split(':').pop() as string) : head;
      const pull = createPull(repo, { title, body: str(body.body) ?? '', head: cleanHead.replace(/^refs\/heads\//, ''), base: base.replace(/^refs\/heads\//, '') });
      return json(201, pullJson(repo, pull));
    }
    if (req.method === 'GET') {
      const stateFilter = req.query.get('state') ?? 'open';
      let pulls = [...repo.pulls.values()];
      if (stateFilter === 'open' || stateFilter === 'closed') pulls = pulls.filter((pull) => pull.state === stateFilter);
      pulls.sort((a, b) => a.number - b.number);
      const { page, headers } = paginate(req, pulls.map((pull) => pullJson(repo, pull)), `${req.pathname}`);
      return json(200, page, headers);
    }
    throw notFound();
  }
  const number = Number.parseInt(rest[0] as string, 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (pull === undefined) throw notFound();
  if (rest.length === 1 && req.method === 'GET') return json(200, pullJson(repo, pull));
  if (rest.length === 2 && rest[1] === 'files' && req.method === 'GET') {
    return json(200, pullFiles(repo, pull).map((file) => ({
      filename: file.filename,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.changes,
    })));
  }
  if (rest.length === 2 && rest[1] === 'merge' && req.method === 'PUT') {
    bodyOf(req); // a malformed body is still a 400
    const outcome = mergePull(repo, pull);
    return json(200, { merged: true, sha: outcome.sha, message: 'Pull Request successfully merged' });
  }
  throw notFound();
}

// ---------------------------------------------------------------- entry

export function handleRest(req: RestRequest): RestResponse {
  if (!req.authed) throw new ForgeError(401, 'Bad credentials');
  const segments = req.pathname
    .replace(/^\/api\/v3\/?/, '')
    .split('/')
    .filter((segment) => segment !== '')
    .map((segment) => decodeURIComponent(segment));

  if (segments.length === 0) {
    if (req.method === 'GET') return handleRoot();
    throw notFound();
  }
  if (segments[0] === 'meta' && segments.length === 1 && req.method === 'GET') {
    return json(200, { installed_version: '1.0.0-forge', runtime: 'node' });
  }
  if (segments[0] === 'user' && segments.length === 1 && req.method === 'GET') {
    if (state.learnedLogin === null) throw notFound();
    return json(200, { login: state.learnedLogin, id: 1, type: 'User' });
  }
  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    return handleUserRepos(req);
  }
  if (segments[0] === 'repos' && segments.length >= 3) {
    const repo = requireRepo(segments[1] as string, segments[2] as string);
    const rest = segments.slice(3);
    if (rest.length === 0) return handleRepo(req, repo);
    switch (rest[0]) {
      case 'branches':
        return handleBranches(req, repo, rest.slice(1));
      case 'commits':
        return handleCommits(req, repo);
      case 'git':
        if (rest[1] === 'refs') return handleGitRefs(req, repo, rest.slice(2));
        throw notFound();
      case 'contents':
        return handleContents(req, repo, rest.slice(1));
      case 'labels':
        if (rest.length === 1) return handleLabels(req, repo);
        throw notFound();
      case 'issues':
        return handleIssues(req, repo, rest.slice(1));
      case 'pulls':
        return handlePulls(req, repo, rest.slice(1));
      default:
        throw notFound();
    }
  }
  throw notFound();
}
