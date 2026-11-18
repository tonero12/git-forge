// graphql.ts — GitHub GraphQL v4 for exactly the document shapes gh and
// github-mcp-server send: a small hand-rolled parser (operations, variables,
// aliases, inline fragments, input objects, enum lists) and an executor over
// the shared store. Global ids are opaque, stable, and round-trippable.

import {
  ForgeError,
  addComment,
  createIssue,
  createPull,
  mergePull,
  pullFiles,
  pullMergeable,
  repoByPath,
  repoOwnerLogin,
  state,
  type IssueRec,
  type PullRec,
  type RepoRec,
} from './store.ts';

// ---------------------------------------------------------------- ids

export function globalId(type: string, numericId: number): string {
  return Buffer.from(`${type}:${numericId}`, 'utf8').toString('base64');
}

function parseGlobalId(id: string): { type: string; numericId: number } | null {
  try {
    const decoded = Buffer.from(id, 'base64').toString('utf8');
    const split = decoded.lastIndexOf(':');
    if (split <= 0) return null;
    const numericId = Number.parseInt(decoded.slice(split + 1), 10);
    if (!Number.isFinite(numericId)) return null;
    return { type: decoded.slice(0, split), numericId };
  } catch {
    return null;
  }
}

function repoByGlobalId(id: string): RepoRec | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Repository') return null;
  return state.repos.find((repo) => repo.id === parsed.numericId) ?? null;
}

function issueByGlobalId(id: string): { repo: RepoRec; issue: IssueRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'Issue') return null;
  for (const repo of state.repos) {
    for (const issue of repo.issues.values()) {
      if (issue.dbId === parsed.numericId) return { repo, issue };
    }
  }
  return null;
}

function pullByGlobalId(id: string): { repo: RepoRec; pull: PullRec } | null {
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.type !== 'PullRequest') return null;
  for (const repo of state.repos) {
    for (const pull of repo.pulls.values()) {
      if (pull.dbId === parsed.numericId) return { repo, pull };
    }
  }
  return null;
}

// ---------------------------------------------------------------- tokenizer

type Token =
  | { readonly kind: 'name'; readonly value: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'punct'; readonly value: string };

function tokenize(document: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  const isNameStart = (ch: string): boolean => /[A-Za-z_]/.test(ch);
  const isNameChar = (ch: string): boolean => /[A-Za-z0-9_]/.test(ch);
  while (i < document.length) {
    const ch = document[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < document.length && document[i] !== '\n') i += 1;
      continue;
    }
    if (document.startsWith('...', i)) {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@|'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (document.startsWith('"""', i)) {
        const end = document.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: document.slice(i + 3, end === -1 ? document.length : end) });
        i = end === -1 ? document.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < document.length && document[j] !== '"') {
        if (document[j] === '\\' && j + 1 < document.length) {
          const esc = document[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += document[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (isNameStart(ch)) {
      let j = i;
      while (j < document.length && isNameChar(document[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: document.slice(i, j) });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < document.length && /[0-9.]/.test(document[j] as string)) j += 1;
      const text = document.slice(i, j);
      tokens.push(text.includes('.') ? { kind: 'float', value: Number.parseFloat(text) } : { kind: 'int', value: Number.parseInt(text, 10) });
      i = j;
      continue;
    }
    i += 1; // unknown character: skip, never hang
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type ValueNode =
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'string'; readonly value: string }
  | { readonly kind: 'int'; readonly value: number }
  | { readonly kind: 'float'; readonly value: number }
  | { readonly kind: 'bool'; readonly value: boolean }
  | { readonly kind: 'null' }
  | { readonly kind: 'enum'; readonly value: string }
  | { readonly kind: 'list'; readonly items: readonly ValueNode[] }
  | { readonly kind: 'object'; readonly fields: ReadonlyArray<{ name: string; value: ValueNode }> };

type SelNode =
  | {
      readonly kind: 'field';
      readonly alias: string | null;
      readonly name: string;
      readonly args: ReadonlyArray<{ name: string; value: ValueNode }>;
      readonly selection: readonly SelNode[] | null;
    }
  | { readonly kind: 'inline'; readonly typeCondition: string; readonly selection: readonly SelNode[] }
  | { readonly kind: 'spread'; readonly name: string };

interface Operation {
  readonly type: 'query' | 'mutation';
  readonly selection: readonly SelNode[];
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];
  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }
  private next(): Token {
    const token = this.tokens[this.pos] as Token;
    this.pos += 1;
    return token;
  }
  private atPunct(value: string): boolean {
    const token = this.peek();
    return token !== undefined && token.kind === 'punct' && token.value === value;
  }
  private skipBalanced(open: string, close: string): void {
    if (!this.atPunct(open)) return;
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.kind === 'punct' && token.value === open) depth += 1;
      if (token.kind === 'punct' && token.value === close) {
        depth -= 1;
        if (depth === 0) return;
      }
    }
  }

  parseDocument(): { operations: Operation[]; fragments: Map<string, readonly SelNode[]> } {
    const operations: Operation[] = [];
    const fragments = new Map<string, readonly SelNode[]>();
    while (this.pos < this.tokens.length) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        const opName = this.peek();
        if (opName !== undefined && opName.kind === 'name') this.next(); // operation name
        this.skipBalanced('(', ')'); // variable definitions
        // directives (none in the suite's documents): skip @name and any (...) after it
        while (this.atPunct('@')) {
          this.next();
          if (this.peek()?.kind === 'name') this.next();
          this.skipBalanced('(', ')');
        }
        operations.push({ type: token.value === 'mutation' ? 'mutation' : 'query', selection: this.parseSelectionSet() });
        continue;
      }
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const nameToken = this.next();
        if (this.peek()?.kind === 'name' && (this.peek() as Token).kind === 'name') this.next(); // 'on'
        if (this.peek()?.kind === 'name') this.next(); // type condition
        fragments.set(nameToken?.kind === 'name' ? nameToken.value : '', this.parseSelectionSet());
        continue;
      }
      this.next();
    }
    return { operations, fragments };
  }

  private parseSelectionSet(): readonly SelNode[] {
    const nodes: SelNode[] = [];
    if (!this.atPunct('{')) return nodes;
    this.next();
    while (this.pos < this.tokens.length && !this.atPunct('}')) {
      const token = this.peek();
      if (token === undefined) break;
      if (token.kind === 'punct' && token.value === '...') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeToken = this.next();
          nodes.push({ kind: 'inline', typeCondition: typeToken?.kind === 'name' ? typeToken.value : '', selection: this.parseSelectionSet() });
        } else if (nextToken !== undefined && nextToken.kind === 'name') {
          this.next();
          nodes.push({ kind: 'spread', name: nextToken.value });
        }
        continue;
      }
      if (token.kind === 'name') {
        this.next();
        let alias: string | null = null;
        let name = token.value;
        if (this.atPunct(':')) {
          this.next();
          alias = name;
          const nameToken = this.next();
          name = nameToken?.kind === 'name' ? nameToken.value : name;
        }
        const args: Array<{ name: string; value: ValueNode }> = [];
        if (this.atPunct('(')) {
          this.next();
          while (this.pos < this.tokens.length && !this.atPunct(')')) {
            const argToken = this.next();
            if (argToken === undefined || argToken.kind !== 'name') break;
            if (this.atPunct(':')) this.next();
            args.push({ name: argToken.value, value: this.parseValue() });
          }
          if (this.atPunct(')')) this.next();
        }
        while (this.atPunct('@')) {
          this.next();
          if (this.peek()?.kind === 'name') this.next();
          this.skipBalanced('(', ')');
        }
        const selection = this.atPunct('{') ? this.parseSelectionSet() : null;
        nodes.push({ kind: 'field', alias, name, args, selection });
        continue;
      }
      this.next();
    }
    if (this.atPunct('}')) this.next();
    return nodes;
  }

  private parseValue(): ValueNode {
    const token = this.next();
    if (token === undefined) return { kind: 'null' };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: token.value };
    if (token.kind === 'float') return { kind: 'float', value: token.value };
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    if (token.kind === 'punct' && token.value === '$') {
      const nameToken = this.next();
      return { kind: 'var', name: nameToken?.kind === 'name' ? nameToken.value : '' };
    }
    if (token.kind === 'punct' && token.value === '[') {
      const items: ValueNode[] = [];
      while (this.pos < this.tokens.length && !this.atPunct(']')) items.push(this.parseValue());
      if (this.atPunct(']')) this.next();
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Array<{ name: string; value: ValueNode }> = [];
      while (this.pos < this.tokens.length && !this.atPunct('}')) {
        const nameToken = this.next();
        if (nameToken === undefined || nameToken.kind !== 'name') break;
        if (this.atPunct(':')) this.next();
        fields.push({ name: nameToken.value, value: this.parseValue() });
      }
      if (this.atPunct('}')) this.next();
      return { kind: 'object', fields };
    }
    return { kind: 'null' };
  }
}

function evalValue(node: ValueNode, variables: Record<string, unknown>): unknown {
  switch (node.kind) {
    case 'var':
      return variables[node.name];
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return node.value;
    case 'null':
      return null;
    case 'list':
      return node.items.map((item) => evalValue(item, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const field of node.fields) out[field.name] = evalValue(field.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- handles

interface Handle {
  readonly __type: string;
  readonly [key: string]: unknown;
}

function repoHandle(repo: RepoRec): Handle {
  return { __type: 'Repository', repo };
}
function issueHandle(repo: RepoRec, issue: IssueRec): Handle {
  return { __type: 'Issue', repo, issue };
}
function pullHandle(repo: RepoRec, pull: PullRec): Handle {
  return { __type: 'PullRequest', repo, pull };
}
function userHandle(login: string): Handle {
  return { __type: 'User', login };
}

// ---------------------------------------------------------------- introspection tables

const TYPE_FIELDS: Readonly<Record<string, readonly string[]>> = {
  Issue: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'files', 'createdAt', 'updatedAt', 'url', 'author', 'commits'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequest', 'pullRequests', 'createdAt', 'updatedAt', 'url', 'isPrivate'],
  User: ['id', 'login', 'name', 'url'],
  Query: ['viewer', 'repository', 'node', 'rateLimit'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

const TYPE_ENUMS: Readonly<Record<string, readonly string[]>> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  PullRequestMergeMethod: ['MERGE', 'SQUASH', 'REBASE'],
  RepositoryPermission: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- connections

function cursorFor(index: number): string {
  return Buffer.from(`cursor:${index}`, 'utf8').toString('base64');
}

function indexAfter(after: unknown): number {
  if (typeof after !== 'string' || after === '') return 0;
  try {
    const decoded = Buffer.from(after, 'base64').toString('utf8');
    if (decoded.startsWith('cursor:')) {
      const index = Number.parseInt(decoded.slice('cursor:'.length), 10);
      if (Number.isFinite(index)) return index + 1;
    }
  } catch {
    // fall through: an undecodable cursor restarts the connection
  }
  return 0;
}

interface Connection {
  readonly nodes: Handle[];
  readonly pageInfo: { hasNextPage: boolean; endCursor: string | null; startCursor: string | null; hasPreviousPage: boolean };
  readonly totalCount: number;
}

function connectionOf(all: readonly Handle[], args: Record<string, unknown>): Connection {
  const start = indexAfter(args.after);
  const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : all.length;
  const nodes = all.slice(start, start + first);
  const lastIndex = start + nodes.length - 1;
  return {
    nodes,
    totalCount: all.length,
    pageInfo: {
      hasNextPage: start + nodes.length < all.length,
      endCursor: nodes.length > 0 ? cursorFor(lastIndex) : null,
      startCursor: nodes.length > 0 ? cursorFor(start) : null,
      hasPreviousPage: start > 0,
    },
  };
}

// ---------------------------------------------------------------- resolvers

type Resolver = (source: Handle, args: Record<string, unknown>) => unknown;

function repoOf(source: Handle): RepoRec {
  return source.repo as RepoRec;
}

const RESOLVERS: Readonly<Record<string, Readonly<Record<string, Resolver>>>> = {
  Query: {
    viewer: () => userHandle(state.learnedLogin ?? ''),
    repository: (_source, args) => {
      const owner = typeof args.owner === 'string' ? args.owner : '';
      const name = typeof args.name === 'string' ? args.name : '';
      const repo = repoByPath(owner, name);
      return repo === null ? null : repoHandle(repo);
    },
    node: (_source, args) => {
      const id = typeof args.id === 'string' ? args.id : '';
      const parsed = parseGlobalId(id);
      if (parsed === null) return null;
      if (parsed.type === 'Repository') {
        const repo = state.repos.find((candidate) => candidate.id === parsed.numericId);
        return repo === undefined ? null : repoHandle(repo);
      }
      if (parsed.type === 'Issue') {
        const found = issueByGlobalId(id);
        return found === null ? null : issueHandle(found.repo, found.issue);
      }
      if (parsed.type === 'PullRequest') {
        const found = pullByGlobalId(id);
        return found === null ? null : pullHandle(found.repo, found.pull);
      }
      if (parsed.type === 'User') return userHandle(state.learnedLogin ?? '');
      return null;
    },
    __type: (_source, args) => {
      const name = typeof args.name === 'string' ? args.name : '';
      if (!(name in TYPE_FIELDS) && !(name in TYPE_ENUMS)) return null;
      return { __type: '__Type', name } as Handle;
    },
  },
  User: {
    login: (source) => source.login as string,
    id: () => globalId('User', 1),
    name: (source) => source.login as string,
    url: () => '',
  },
  Repository: {
    id: (source) => globalId('Repository', repoOf(source).id),
    databaseId: (source) => repoOf(source).id,
    name: (source) => repoOf(source).name,
    nameWithOwner: (source) => `${repoOwnerLogin(repoOf(source))}/${repoOf(source).name}`,
    owner: (source) => userHandle(repoOwnerLogin(repoOf(source))),
    defaultBranchRef: (source) => {
      const repo = repoOf(source);
      const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
      return tip === undefined ? null : ({ __type: 'Ref', name: repo.defaultBranch } as Handle);
    },
    viewerPermission: () => 'ADMIN',
    hasIssuesEnabled: () => true,
    isPrivate: (source) => repoOf(source).isPrivate,
    issue: (source, args) => {
      const repo = repoOf(source);
      const issue = typeof args.number === 'number' ? repo.issues.get(args.number) : undefined;
      return issue === undefined ? null : issueHandle(repo, issue);
    },
    issues: (source, args) => {
      const repo = repoOf(source);
      let issues = [...repo.issues.values()];
      const states = Array.isArray(args.states) ? (args.states as unknown[]).filter((value): value is string => typeof value === 'string') : null;
      if (states !== null && states.length > 0) {
        issues = issues.filter((issue) => states.includes(issue.state.toUpperCase()));
      }
      const orderBy = (args.orderBy ?? null) as { field?: string; direction?: string } | null;
      if (orderBy !== null && orderBy.field === 'CREATED_AT') {
        issues.sort((a, b) => (orderBy.direction === 'ASC' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
      } else {
        issues.sort((a, b) => a.number - b.number);
      }
      const connection = connectionOf(issues.map((issue) => issueHandle(repo, issue)), args);
      return { __type: 'IssueConnection', ...connection } as Handle;
    },
    pullRequest: (source, args) => {
      const repo = repoOf(source);
      const pull = typeof args.number === 'number' ? repo.pulls.get(args.number) : undefined;
      return pull === undefined ? null : pullHandle(repo, pull);
    },
    pullRequests: (source, args) => {
      const repo = repoOf(source);
      const pulls = [...repo.pulls.values()].sort((a, b) => b.createdSeq - a.createdSeq);
      const connection = connectionOf(pulls.map((pull) => pullHandle(repo, pull)), args);
      return { __type: 'PullRequestConnection', ...connection } as Handle;
    },
  },
  Ref: {
    name: (source) => source.name as string,
  },
  Issue: {
    id: (source) => globalId('Issue', (source.issue as IssueRec).dbId),
    number: (source) => (source.issue as IssueRec).number,
    title: (source) => (source.issue as IssueRec).title,
    body: (source) => (source.issue as IssueRec).body,
    state: (source) => (source.issue as IssueRec).state.toUpperCase(),
  },
  PullRequest: {
    id: (source) => globalId('PullRequest', (source.pull as PullRec).dbId),
    number: (source) => (source.pull as PullRec).number,
    title: (source) => (source.pull as PullRec).title,
    body: (source) => (source.pull as PullRec).body,
    state: (source) => {
      const pull = source.pull as PullRec;
      return pull.merged ? 'MERGED' : pull.state.toUpperCase();
    },
    merged: (source) => (source.pull as PullRec).merged,
    headRefName: (source) => (source.pull as PullRec).head,
    baseRefName: (source) => (source.pull as PullRec).base,
    mergeable: (source) => pullMergeable(source.repo as RepoRec, source.pull as PullRec),
    files: (source, args) => {
      const files = pullFiles(source.repo as RepoRec, source.pull as PullRec);
      const first = typeof args.first === 'number' ? Math.max(0, Math.trunc(args.first)) : files.length;
      const nodes = files.slice(0, first).map((file) => ({ __type: 'PullRequestChangedFile', path: file.filename }) as Handle);
      return { __type: 'PullRequestFilesConnection', nodes, totalCount: files.length } as Handle;
    },
  },
  IssueConnection: {
    nodes: (source) => source.nodes as Handle[],
    pageInfo: (source) => ({ __type: 'PageInfo', ...(source.pageInfo as object) }) as Handle,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestConnection: {
    nodes: (source) => source.nodes as Handle[],
    pageInfo: (source) => ({ __type: 'PageInfo', ...(source.pageInfo as object) }) as Handle,
    totalCount: (source) => source.totalCount as number,
  },
  PullRequestFilesConnection: {
    nodes: (source) => source.nodes as Handle[],
    totalCount: (source) => source.totalCount as number,
  },
  PageInfo: {
    hasNextPage: (source) => source.hasNextPage as boolean,
    hasPreviousPage: (source) => source.hasPreviousPage as boolean,
    endCursor: (source) => source.endCursor as string | null,
    startCursor: (source) => source.startCursor as string | null,
  },
  PullRequestChangedFile: {
    path: (source) => source.path as string,
  },
  Comment: {
    id: (source) => globalId('IssueComment', source.dbId as number),
    body: (source) => source.body as string,
  },
  __Type: {
    name: (source) => source.name as string,
    kind: (source) => ((source.name as string) in TYPE_ENUMS ? 'ENUM' : 'OBJECT'),
    fields: (source) => (TYPE_FIELDS[source.name as string] ?? []).map((name) => ({ __type: '__Field', name }) as Handle),
    enumValues: (source) => (TYPE_ENUMS[source.name as string] ?? []).map((name) => ({ __type: '__EnumValue', name }) as Handle),
  },
  __Field: {
    name: (source) => source.name as string,
  },
  __EnumValue: {
    name: (source) => source.name as string,
  },
  Mutation: {
    createIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (repo === null) throw new ForgeError(422, 'repositoryId does not name a repository');
      const issue = createIssue(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: typeof input.body === 'string' ? input.body : '',
      });
      return { __type: 'CreateIssuePayload', issue: issueHandle(repo, issue) } as Handle;
    },
    closeIssue: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.issueId === 'string' ? issueByGlobalId(input.issueId) : null;
      if (found === null) throw new ForgeError(422, 'issueId does not name an issue');
      found.issue.state = 'closed';
      return { __type: 'CloseIssuePayload', issue: issueHandle(found.repo, found.issue) } as Handle;
    },
    createPullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const repo = typeof input.repositoryId === 'string' ? repoByGlobalId(input.repositoryId) : null;
      if (repo === null) throw new ForgeError(422, 'repositoryId does not name a repository');
      const pull = createPull(repo, {
        title: typeof input.title === 'string' ? input.title : '',
        body: '',
        head: typeof input.headRefName === 'string' ? input.headRefName : '',
        base: typeof input.baseRefName === 'string' ? input.baseRefName : '',
      });
      return { __type: 'CreatePullRequestPayload', pullRequest: pullHandle(repo, pull) } as Handle;
    },
    mergePullRequest: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.pullRequestId === 'string' ? pullByGlobalId(input.pullRequestId) : null;
      if (found === null) throw new ForgeError(422, 'pullRequestId does not name a pull request');
      mergePull(found.repo, found.pull);
      return { __type: 'MergePullRequestPayload', pullRequest: pullHandle(found.repo, found.pull) } as Handle;
    },
    addComment: (_source, args) => {
      const input = (args.input ?? {}) as Record<string, unknown>;
      const found = typeof input.subjectId === 'string' ? issueByGlobalId(input.subjectId) : null;
      if (found === null) throw new ForgeError(422, 'subjectId does not name an issue');
      const comment = addComment(found.issue, typeof input.body === 'string' ? input.body : '', repoOwnerLogin(found.repo));
      const node = { __type: 'Comment', dbId: comment.dbId, body: comment.body } as Handle;
      return { __type: 'AddCommentPayload', commentEdge: { __type: 'CommentEdge', node } as Handle } as Handle;
    },
  },
  CreateIssuePayload: { issue: (source) => source.issue as Handle },
  CloseIssuePayload: { issue: (source) => source.issue as Handle },
  CreatePullRequestPayload: { pullRequest: (source) => source.pullRequest as Handle },
  MergePullRequestPayload: { pullRequest: (source) => source.pullRequest as Handle },
  AddCommentPayload: { commentEdge: (source) => source.commentEdge as Handle },
  CommentEdge: { node: (source) => source.node as Handle },
};

// ---------------------------------------------------------------- executor

interface ExecContext {
  readonly variables: Record<string, unknown>;
  readonly fragments: ReadonlyMap<string, readonly SelNode[]>;
  readonly errors: Array<{ message: string }>;
}

function executeSelectionSet(typeName: string, source: Handle, selection: readonly SelNode[], ctx: ExecContext): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const node of selection) {
    if (node.kind === 'inline') {
      if (node.typeCondition === typeName || node.typeCondition === '') {
        Object.assign(out, executeSelectionSet(typeName, source, node.selection, ctx));
      }
      continue;
    }
    if (node.kind === 'spread') {
      const fragment = ctx.fragments.get(node.name);
      if (fragment !== undefined) Object.assign(out, executeSelectionSet(typeName, source, fragment, ctx));
      continue;
    }
    const responseKey = node.alias ?? node.name;
    if (node.name === '__typename') {
      out[responseKey] = typeName;
      continue;
    }
    const resolver = RESOLVERS[typeName]?.[node.name];
    if (resolver === undefined) {
      ctx.errors.push({ message: `Cannot query field "${node.name}" on type "${typeName}".` });
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const arg of node.args) args[arg.name] = evalValue(arg.value, ctx.variables);
    let value: unknown;
    try {
      value = resolver(source, args);
    } catch (err) {
      ctx.errors.push({ message: err instanceof Error ? err.message : String(err) });
      out[responseKey] = null;
      continue;
    }
    if (node.selection === null || value === null || value === undefined) {
      out[responseKey] = value ?? null;
      continue;
    }
    if (Array.isArray(value)) {
      out[responseKey] = value.map((item) => {
        if (item === null || typeof item !== 'object') return item;
        const handle = item as Handle;
        return executeSelectionSet(handle.__type, handle, node.selection as readonly SelNode[], ctx);
      });
      continue;
    }
    if (typeof value === 'object') {
      const handle = value as Handle;
      out[responseKey] = executeSelectionSet(handle.__type, handle, node.selection, ctx);
      continue;
    }
    out[responseKey] = value;
  }
  return out;
}

function executeOperation(operation: Operation, variables: Record<string, unknown>, fragments: ReadonlyMap<string, readonly SelNode[]>): Record<string, unknown> {
  const ctx: ExecContext = { variables, fragments, errors: [] };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelectionSet(rootType, { __type: rootType }, operation.selection, ctx);
  const envelope: Record<string, unknown> = { data };
  if (ctx.errors.length > 0) envelope.errors = ctx.errors;
  return envelope;
}

// ---------------------------------------------------------------- entry

export interface GraphQLResponse {
  readonly status: number;
  readonly body: unknown;
}

export function handleGraphQL(bodyText: string, authed: boolean): GraphQLResponse {
  if (!authed) return { status: 401, body: { message: 'Bad credentials' } };
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return { status: 400, body: { errors: [{ message: 'Problems parsing JSON' }] } };
  }
  const runOne = (entry: unknown): Record<string, unknown> => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return { errors: [{ message: 'Operation must be an object' }] };
    }
    const query = (entry as Record<string, unknown>).query;
    const variables = ((entry as Record<string, unknown>).variables ?? {}) as Record<string, unknown>;
    if (typeof query !== 'string') return { errors: [{ message: 'query must be a string' }] };
    try {
      const { operations, fragments } = new Parser(tokenize(query)).parseDocument();
      const operation = operations[0];
      if (operation === undefined) return { errors: [{ message: 'No operation found' }] };
      return executeOperation(operation, variables, fragments);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
    }
  };
  if (Array.isArray(parsed)) {
    return { status: 200, body: parsed.map(runOne) };
  }
  return { status: 200, body: runOne(parsed) };
}
