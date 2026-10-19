import { createHash, randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { ServerConfig, ServerInfo } from '../../src/types/index.js';

const mockClients: any[] = [];
const mockDefinitions = new Map<string, ServerConfig>();
const mockGroups = new Map<string, unknown>();
const makeClient = () => ({
  connect: jest.fn().mockResolvedValue(undefined),
  close: jest.fn(),
  getServerCapabilities: jest.fn(() => ({ tools: {}, prompts: {}, resources: {} })),
  getServerVersion: jest.fn(() => ({ version: 'fixture-2' })),
  getInstructions: jest.fn(() => 'Follow fixture instructions'),
  listTools: jest
    .fn()
    .mockResolvedValue({ tools: [{ name: 'inspect', inputSchema: { type: 'object' } }] }),
  listPrompts: jest.fn().mockResolvedValue({ prompts: [{ name: 'guide' }] }),
  listResources: jest.fn().mockResolvedValue({ resources: [] }),
  listResourceTemplates: jest
    .fn()
    .mockResolvedValue({ resourceTemplates: [{ name: 'record', uriTemplate: 'record://{id}' }] }),
  callTool: jest.fn().mockResolvedValue({ content: [{ type: 'text', text: 'ok' }] }),
  getPrompt: jest.fn().mockResolvedValue({ messages: [] }),
  readResource: jest
    .fn()
    .mockImplementation(async ({ uri }) => ({ contents: [{ uri, text: 'record' }] })),
});

jest.mock('dotenv', () => ({ config: jest.fn() }));
jest.mock('@modelcontextprotocol/client', () => ({
  ...jest.requireActual('@modelcontextprotocol/client'),
  Client: jest.fn().mockImplementation(() => {
    const client = makeClient();
    mockClients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
  SSEClientTransport: jest.fn().mockImplementation(() => ({ close: jest.fn() })),
}));
jest.mock('../../src/services/services.js', () => ({
  getDataService: () => ({ filterData: (data: unknown) => data }),
}));
jest.mock('../../src/config/index.js', () => ({
  ...jest.requireActual('../../src/config/index.js'),
  getNameSeparator: () => '::',
  getSettingsPath: () => '/fixture/settings.json',
}));
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: jest.fn().mockResolvedValue(undefined),
  createRedirectValidatingFetch: (fetch: unknown) => fetch,
}));
jest.mock('../../src/services/oauthService.js', () => ({ initializeAllOAuthClients: jest.fn() }));
jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: async () => undefined,
}));
jest.mock('../../src/services/sseService.js', () => ({ getGroup: () => '' }));
jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: () => ({ logToolCall: jest.fn().mockResolvedValue(undefined) }),
}));
jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: () => false,
}));
jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
  normalizeGroupServers: (servers: Array<string | object>) =>
    servers.map((server) =>
      typeof server === 'string'
        ? { name: server, tools: 'all', prompts: 'all', resources: 'all' }
        : server,
    ),
}));
jest.mock('../../src/dao/index.js', () => ({
  getServerDao: () => ({
    findAll: async () => [...mockDefinitions].map(([name, config]) => ({ name, ...config })),
    findById: async (name: string) =>
      mockDefinitions.has(name) ? { name, ...mockDefinitions.get(name) } : undefined,
  }),
  getUserDao: () => ({ findByUsername: async () => undefined }),
  getGroupDao: () => ({
    findByName: async (name: string) => mockGroups.get(name),
    findById: async () => undefined,
  }),
  getSystemConfigDao: () => ({ get: async () => ({}) }),
  getBuiltinPromptDao: () => ({ findEnabled: async () => [], findByName: async () => undefined }),
  getBuiltinResourceDao: () => ({ findEnabled: async () => [], findByUri: async () => undefined }),
}));

import * as service from '../../src/services/mcpService.js';
import {
  expandServerConfig,
  getServerEnvironment,
} from '../../src/services/serverConfigEnvironment.js';
import { RequestContextService } from '../../src/services/requestContextService.js';

const context = <T>(operation: () => T, sessionId = 'session-A', stateless = false) =>
  RequestContextService.getInstance().runWithCustomRequestContext(
    {
      group: 'fixture',
      sessionId,
      stateless,
      clientStateScope: 'credential-A',
      headers: stateless ? { 'x-mcphub-state-id': '65b523af-e4d0-4d99-8e06-461a62a14967' } : {},
    },
    operation,
  );

const install = (config: ServerConfig = {}) => {
  const definition: ServerConfig = {
    type: 'streamable-http',
    url: 'https://example.com/mcp',
    enabled: true,
    ...config,
  };
  mockDefinitions.set('fixture', definition);
  const client = makeClient();
  const info = {
    name: 'fixture',
    enabled: true,
    status: 'connected',
    client,
    config: definition,
    tools: ['inspect', 'search_tools', 'describe_tool', 'call_tool'].map((name) => ({
      name: `fixture::${name}`,
      inputSchema: { type: 'object' },
    })),
    prompts: [{ name: 'fixture::guide' }],
    resources: [],
    options: {},
  } as unknown as ServerInfo;
  service.setServerInfosForTest([info]);
  return { client, info, definition };
};

beforeEach(async () => {
  await service.cleanupAllServers();
  mockClients.length = 0;
  mockDefinitions.clear();
  mockGroups.clear();
});
afterEach(async () => {
  await service.cleanupAllServers();
});

it.each(['stdio', 'streamable-http'] as const)(
  'projects raw direct names and forwards colliding meta-tools for %s',
  async (type) => {
    const { client } = install({ type, ...(type === 'stdio' ? { command: 'unused' } : {}) });
    const listed = await context(() =>
      service.handleListToolsRequest({}, { sessionId: 'session-A' }),
    );
    expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual([
      'inspect',
      'search_tools',
      'describe_tool',
      'call_tool',
    ]);
    for (const name of ['search_tools', 'describe_tool', 'call_tool']) {
      const result = await context(() =>
        service.handleCallToolRequest(
          { params: { name, arguments: { value: 'sent upstream' } } },
          { sessionId: 'session-A' },
        ),
      );
      expect(result.isError).not.toBe(true);
      expect(client.callTool).toHaveBeenLastCalledWith(
        { name, arguments: { value: 'sent upstream' } },
        expect.anything(),
      );
    }
  },
);

it('keeps group precedence, aliases and selections when a group shares a server name', async () => {
  const { client } = install();
  mockGroups.set('fixture', {
    name: 'fixture',
    servers: [
      {
        name: 'fixture',
        tools: ['inspect'],
        prompts: ['guide'],
        resources: ['record://allowed'],
        alias: 'chosen',
      },
    ],
  });
  const listed = await context(() =>
    service.handleListToolsRequest({}, { sessionId: 'session-A' }),
  );
  expect(listed.tools.map((tool: { name: string }) => tool.name)).toEqual(['chosen::inspect']);
  const denied = await context(() =>
    service.handleReadResourceRequest(
      { params: { uri: 'record://unlisted' } },
      { sessionId: 'session-A' },
    ),
  );
  expect(denied.contents[0].text).toContain('Resource not found');
  expect(client.readResource).not.toHaveBeenCalled();
});

it('lists and retrieves raw prompts symmetrically and respects raw disabled names', async () => {
  const { client, definition } = install();
  expect(
    (await context(() => service.handleListPromptsRequest({}, { sessionId: 'session-A' })))
      .prompts[0].name,
  ).toBe('guide');
  expect(
    (
      await context(() =>
        service.handleGetPromptRequest({ params: { name: 'guide' } }, { sessionId: 'session-A' }),
      )
    ).messages,
  ).toEqual([]);
  expect(client.getPrompt).toHaveBeenCalledWith({ name: 'guide', arguments: undefined });
  definition.prompts = { guide: { enabled: false } };
  expect(
    (await context(() => service.handleListPromptsRequest({}, { sessionId: 'session-A' }))).prompts,
  ).toEqual([]);
  expect(
    (
      await context(() =>
        service.handleGetPromptRequest({ params: { name: 'guide' } }, { sessionId: 'session-A' }),
      )
    ).isError,
  ).toBe(true);
});

it.each([false, true])(
  'uses one isolated HTTP operation client for tools, prompts, templates and dynamic URI reads (stateless=%s)',
  async (stateless) => {
    const { client, definition } = install({ perSessionClient: true });
    const run = <T>(operation: () => T) => context(operation, 'session-A', stateless);
    expect(
      (
        await run(() =>
          service.handleCallToolRequest(
            { params: { name: 'inspect', arguments: {} } },
            { sessionId: 'session-A' },
          ),
        )
      ).isError,
    ).not.toBe(true);
    expect(
      (
        await run(() =>
          service.handleGetPromptRequest({ params: { name: 'guide' } }, { sessionId: 'session-A' }),
        )
      ).messages,
    ).toEqual([]);
    expect(
      (await run(() => service.handleListResourceTemplatesRequest({}, { sessionId: 'session-A' })))
        .resourceTemplates[0].uriTemplate,
    ).toBe('record://{id}');
    expect(
      (
        await run(() =>
          service.handleReadResourceRequest(
            { params: { uri: 'record://dynamic' } },
            { sessionId: 'session-A' },
          ),
        )
      ).contents[0].text,
    ).toBe('record');
    expect(mockClients).toHaveLength(1);
    for (const method of ['callTool', 'getPrompt', 'listResourceTemplates', 'readResource']) {
      expect(mockClients[0][method]).toHaveBeenCalledTimes(1);
      expect(client[method as keyof typeof client]).not.toHaveBeenCalled();
    }
    definition.resources = { 'record://blocked': { enabled: false } };
    expect(
      (
        await run(() =>
          service.handleReadResourceRequest(
            { params: { uri: 'record://blocked' } },
            { sessionId: 'session-A' },
          ),
        )
      ).contents[0].text,
    ).toContain('Resource not found');
    expect(mockClients[0].readResource).toHaveBeenCalledTimes(1);
  },
);

it('restores initialize instructions and upstream version without reconnecting a persistent catalog', async () => {
  const prior = process.env.MCPHUB_CATALOG_DIR;
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'gateway-metadata-'));
  process.env.MCPHUB_CATALOG_DIR = directory;
  try {
    mockDefinitions.set('fixture', {
      type: 'stdio',
      command: process.execPath,
      catalogMode: 'persistent',
      enabled: true,
    });
    // Only discovery is mocked; the snapshot is written, validated, and restored from disk.
    const transport = jest
      .spyOn(service, 'createTransportFromConfig')
      .mockResolvedValue({ close: jest.fn() });
    try {
      await service.initializeClientsFromSettings(true);
      await service.bootstrapServerCatalog('fixture');
      service.setServerInfosForTest([]);
      await service.initializeClientsFromSettings(true);
      expect(service.getServerByName('fixture')).toEqual(
        expect.objectContaining({
          instructions: 'Follow fixture instructions',
          version: 'fixture-2',
          status: 'disconnected',
        }),
      );
      expect(mockClients).toHaveLength(1);
      const snapshotName = (await fs.readdir(directory)).find((name) => name.endsWith('.json'))!;
      const snapshotPath = path.join(directory, snapshotName);
      const legacy = JSON.parse(await fs.readFile(snapshotPath, 'utf8'));
      delete legacy.catalog.instructions;
      delete legacy.catalog.serverVersion;
      await fs.writeFile(snapshotPath, JSON.stringify(legacy));
      service.setServerInfosForTest([]);
      await service.initializeClientsFromSettings(true);
      expect(service.getServerByName('fixture')!.tools[0].name).toBe('fixture::inspect');
      expect(service.getServerByName('fixture')!.instructions).toBeUndefined();
      expect(mockClients).toHaveLength(1);
    } finally {
      transport.mockRestore();
    }
  } finally {
    if (prior === undefined) delete process.env.MCPHUB_CATALOG_DIR;
    else process.env.MCPHUB_CATALOG_DIR = prior;
    await fs.rm(directory, { recursive: true, force: true });
  }
});

it('spawns an SDK stdio fixture with only safe OS inheritance and explicit secret bindings', async () => {
  const prior = process.env;
  const secret = randomBytes(16).toString('hex') + '${GATEWAY_UNRELATED_SECRET}';
  const digest = createHash('sha256').update(secret).digest('hex');
  process.env = {
    ...prior,
    GATEWAY_UNRELATED_SECRET: randomBytes(16).toString('hex'),
    GATEWAY_BOUND_SECRET: secret,
  };
  const fixture = String.raw`process.stdout.write(JSON.stringify({jsonrpc:'2.0',method:'fixture/env',params:{unrelatedAbsent:!Object.hasOwn(process.env,'GATEWAY_UNRELATED_SECRET'),sourceAbsent:!Object.hasOwn(process.env,'GATEWAY_BOUND_SECRET'),boundMatches:require('node:crypto').createHash('sha256').update(process.env.BOUND||'').digest('hex')===process.argv[1],hasPath:!!process.env.PATH}})+'\n');process.stdin.resume();`;
  let transport;
  try {
    const config = await expandServerConfig({
      command: process.execPath,
      args: ['-e', fixture, digest],
      inheritEnv: false,
      env: { BOUND: '${GATEWAY_BOUND_SECRET}' },
    });
    expect((await expandServerConfig({ ...config })).env!.BOUND === secret).toBe(true);
    const env = await getServerEnvironment(config);
    expect(env.BOUND === secret).toBe(true);
    expect(env.GATEWAY_UNRELATED_SECRET).toBeUndefined();
    transport = await service.createTransportFromConfig('environment-fixture', config);
    const observed = new Promise((resolve) => {
      transport.onmessage = (message: unknown) => resolve(message);
    });
    await transport.start();
    await expect(observed).resolves.toEqual({
      jsonrpc: '2.0',
      method: 'fixture/env',
      params: { unrelatedAbsent: true, sourceAbsent: true, boundMatches: true, hasPath: true },
    });
    expect((await getServerEnvironment({})).GATEWAY_BOUND_SECRET === secret).toBe(true);
  } finally {
    await transport?.close();
    process.env = prior;
  }
});
