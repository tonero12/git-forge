// mcp.ts — the Model Context Protocol endpoint: legacy-era streamable HTTP
// (server/discover is refused with -32601, so the client falls back to
// initialize), plain JSON responses, six GitHub tools over the shared store.

import {
  ForgeError,
  createIssue,
  createPull,
  createRepo,
  mergePull,
  repoByName,
  repoByPath,
  repoOwnerLogin,
  state,
  type RepoRec,
} from './store.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

export interface McpResponse {
  readonly status: number;
  readonly body?: unknown;
}

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly properties: Readonly<Record<string, { type: string; description: string }>>;
  readonly required: readonly string[];
}

const TOOL_DEFS: readonly ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    properties: {
      owner: { type: 'string', description: 'The account the repository belongs to.' },
      name: { type: 'string', description: 'The repository name.' },
      description: { type: 'string', description: 'A short description of the repository.' },
      private: { type: 'boolean', description: 'Whether the repository is private.' },
    },
    required: ['name'],
  },
  {
    name: 'get_repo',
    description: 'Read one repository by owner and name.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The issue title.' },
      body: { type: 'string', description: 'The issue body.' },
    },
    required: ['owner', 'repo', 'title'],
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      state: { type: 'string', description: 'Filter by state: open, closed or all.' },
    },
    required: ['owner', 'repo'],
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch into a base branch.',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      title: { type: 'string', description: 'The pull request title.' },
      body: { type: 'string', description: 'The pull request body.' },
      head: { type: 'string', description: 'The head branch name.' },
      base: { type: 'string', description: 'The base branch name.' },
    },
    required: ['owner', 'repo', 'title', 'head', 'base'],
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number (squash).',
    properties: {
      owner: { type: 'string', description: 'The repository owner login.' },
      repo: { type: 'string', description: 'The repository name.' },
      pull_number: { type: 'number', description: 'The pull request number.' },
    },
    required: ['owner', 'repo', 'pull_number'],
  },
];

// Built once, in a fixed order: tools/list must be byte-identical across calls.
const TOOLS = TOOL_DEFS.map((tool) => ({
  name: tool.name,
  description: tool.description,
  inputSchema: {
    type: 'object',
    properties: Object.fromEntries(Object.entries(tool.properties).map(([name, schema]) => [name, { type: schema.type, description: schema.description }])),
    required: [...tool.required],
  },
}));

function rpcResult(id: unknown, result: unknown): McpResponse {
  return { status: 200, body: { jsonrpc: '2.0', id, result } };
}

function rpcError(id: unknown, code: number, message: string, status = 200): McpResponse {
  return { status, body: { jsonrpc: '2.0', id, error: { code, message } } };
}

function toolSuccess(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
    structuredContent: value as Record<string, unknown>,
    isError: false,
  };
}

function findRepo(owner: unknown, repo: unknown): RepoRec {
  const repoName = typeof repo === 'string' ? repo : '';
  const ownerName = typeof owner === 'string' ? owner : '';
  const byPath = ownerName !== '' ? repoByPath(ownerName, repoName) : null;
  const found = byPath ?? repoByName(repoName);
  if (found === null) throw new ForgeError(404, `repository ${ownerName}/${repoName} not found`);
  return found;
}

function requireArgs(args: Record<string, unknown>, tool: ToolDef): void {
  for (const name of tool.required) {
    const value = args[name];
    if (value === undefined || value === null || value === '') {
      throw new ForgeError(400, `missing required argument "${name}" for tool ${tool.name}`);
    }
  }
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const def = TOOL_DEFS.find((tool) => tool.name === name);
  if (def === undefined) throw new McpToolError(-32602, `unknown tool "${name}"`);
  requireArgs(args, def);
  switch (name) {
    case 'create_repo': {
      const repo = createRepo({
        name: String(args.name),
        description: typeof args.description === 'string' ? args.description : '',
        isPrivate: args.private === true,
        owner: typeof args.owner === 'string' ? args.owner : undefined,
      });
      return toolSuccess(repoJson(repo));
    }
    case 'get_repo': {
      const repo = findRepo(args.owner, args.repo);
      return toolSuccess(repoJson(repo));
    }
    case 'create_issue': {
      const repo = findRepo(args.owner, args.repo);
      const issue = createIssue(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
      });
      return toolSuccess(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = findRepo(args.owner, args.repo);
      const filter = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()].sort((a, b) => a.number - b.number);
      if (filter === 'open' || filter === 'closed') issues = issues.filter((issue) => issue.state === filter);
      const list = issues.map((issue) => issueJson(repo, issue));
      return toolSuccess({ issues: list, total: list.length });
    }
    case 'create_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      const pull = createPull(repo, {
        title: String(args.title),
        body: typeof args.body === 'string' ? args.body : '',
        head: String(args.head),
        base: String(args.base),
      });
      return toolSuccess(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const repo = findRepo(args.owner, args.repo);
      const number = typeof args.pull_number === 'number' ? args.pull_number : Number.parseInt(String(args.pull_number ?? ''), 10);
      const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
      if (pull === undefined) throw new ForgeError(404, `pull request ${String(args.pull_number)} not found`);
      mergePull(repo, pull);
      return toolSuccess(pullJson(repo, pull));
    }
    default:
      throw new McpToolError(-32602, `unknown tool "${name}"`);
  }
}

class McpToolError extends Error {
  readonly code: number;
  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// ---------------------------------------------------------------- entry

export function handleMcp(method: string, bodyText: string, authed: boolean): McpResponse {
  if (method === 'DELETE') return { status: 204 };
  if (method === 'GET') return rpcError(null, -32601, 'Method not found', 405);
  if (method !== 'POST') return rpcError(null, -32601, 'Method not found', 405);

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    // A body that is not JSON at all: JSON-RPC parse error, HTTP 400.
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { status: 400, body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } } };
  }
  const request = parsed as Record<string, unknown>;
  const id = request.id;
  const rpcMethod = typeof request.method === 'string' ? request.method : '';

  // Notifications (no id) are accepted and ignored.
  if (id === undefined) return { status: 202 };

  if (!authed) {
    return { status: 401, body: { jsonrpc: '2.0', id, error: { code: -32602, message: 'Unauthorized' } } };
  }

  const params = (request.params ?? {}) as Record<string, unknown>;
  switch (rpcMethod) {
    case 'server/discover':
      // Legacy-era server: discover is refused as method-not-found so the
      // client falls back to the initialize handshake.
      return rpcError(id, -32601, 'Method not found: server/discover');
    case 'initialize': {
      const offered = typeof params.protocolVersion === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(params.protocolVersion) ? params.protocolVersion : '2025-11-25';
      return rpcResult(id, {
        protocolVersion: offered,
        capabilities: { tools: {} },
        serverInfo: { name: 'git-forge', version: '1.0.0' },
      });
    }
    case 'tools/list':
      return rpcResult(id, { tools: TOOLS });
    case 'tools/call': {
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (params.arguments ?? {}) as Record<string, unknown>;
      try {
        return rpcResult(id, callTool(toolName, args));
      } catch (err) {
        if (err instanceof McpToolError) return rpcError(id, err.code, err.message);
        if (err instanceof ForgeError) return rpcError(id, -32602, err.message);
        return rpcError(id, -32602, err instanceof Error ? err.message : String(err));
      }
    }
    case 'ping':
      return rpcResult(id, {});
    default:
      return rpcError(id, -32601, `Method not found: ${rpcMethod}`);
  }
}

export function mcpLearnedLogin(): string | null {
  return state.learnedLogin;
}
