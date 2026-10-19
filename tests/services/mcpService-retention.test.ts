/// <reference types="jest" />

// Tracks every upstream Client the SUT constructs via `new Client(...)`, so tests
// can assert how many isolated clients were created and inspect/close them.
const mockCreatedClients: any[] = [];
let mockConnectBehavior: (() => Promise<void>) | undefined;
const makeOkResult = () => ({
  content: [{ type: 'text', text: 'ok' }],
  isError: false,
});

jest.mock('@modelcontextprotocol/client', () => ({
  ...jest.requireActual('@modelcontextprotocol/client'),
  Client: jest.fn().mockImplementation(() => {
    const client = {
      connect: jest.fn(async () => {
        await mockConnectBehavior?.();
      }),
      close: jest.fn(),
      getServerCapabilities: jest.fn(() => ({ tools: {} })),
      getServerVersion: jest.fn(() => ({ version: '1.0.0' })),
      getInstructions: jest.fn(() => undefined),
      listTools: jest.fn().mockResolvedValue({ tools: [] }),
      callTool: jest.fn().mockResolvedValue(makeOkResult()),
      getPrompt: jest.fn().mockResolvedValue({ messages: [] }),
      readResource: jest
        .fn()
        .mockResolvedValue({ contents: [{ uri: 'test://resource', text: 'state' }] }),
    };
    mockCreatedClients.push(client);
    return client;
  }),
  StreamableHTTPClientTransport: MockStreamableHTTPClientTransport,
  SSEClientTransport: MockSSEClientTransport,
}));

const mockCreatedTransports: any[] = [];

class MockStreamableHTTPClientTransport {
  close = jest.fn();
  constructor(
    public url: URL,
    public options?: any,
  ) {
    mockCreatedTransports.push(this);
  }
}

class MockSSEClientTransport {
  close = jest.fn();
  constructor(
    public url: URL,
    public options?: any,
  ) {
    mockCreatedTransports.push(this);
  }
}

class MockStdioClientTransport {
  close = jest.fn();
  // Expose a fake stdio child pid via the SDK's public `pid` getter so cleanup
  // exercises the process-tree path.
  pid = 4242;
  stderr = { on: jest.fn() };
  constructor(public options?: any) {
    mockCreatedTransports.push(this);
  }
}

jest.mock('@modelcontextprotocol/client/stdio', () => ({
  StdioClientTransport: MockStdioClientTransport,
}));

// Kill the process tree without touching real processes.
const mockTreeKill = jest.fn((_pid: number, _signal: string, cb?: (err?: Error) => void) => {
  if (cb) cb();
});
jest.mock('tree-kill', () => mockTreeKill);

// SSRF guard is real in production; mock it here so tests stay hermetic (no DNS).
jest.mock('../../src/utils/ssrf.js', () => ({
  assertSafeUrl: jest.fn().mockResolvedValue(undefined),
  createRedirectValidatingFetch: jest.fn((fetchImpl: any) => fetchImpl),
}));

jest.mock('../../src/services/oauthService.js', () => ({
  initializeAllOAuthClients: jest.fn(),
}));

jest.mock('../../src/services/mcpOAuthProvider.js', () => ({
  createOAuthProvider: jest.fn(async () => undefined),
}));

jest.mock('../../src/services/groupService.js', () => ({
  getServersInGroup: jest.fn(),
  getServerConfigInGroup: jest.fn(),
}));

jest.mock('../../src/services/sseService.js', () => ({
  getGroup: jest.fn(() => ''),
}));

jest.mock('../../src/services/vectorSearchService.js', () => ({
  removeServerToolEmbeddings: jest.fn(),
  saveToolsAsVectorEmbeddings: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/services.js', () => ({
  getDataService: jest.fn(() => ({
    filterData: (data: any) => data,
  })),
}));

jest.mock('../../src/services/smartRoutingService.js', () => ({
  initSmartRoutingService: jest.fn(),
  getSmartRoutingTools: jest.fn(),
  handleSearchToolsRequest: jest.fn(),
  handleDescribeToolRequest: jest.fn(),
  isSmartRoutingGroup: jest.fn(() => false),
}));

jest.mock('../../src/services/activityLoggingService.js', () => ({
  getActivityLoggingService: jest.fn(() => ({
    logToolCall: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../../src/services/keepAliveService.js', () => ({
  setupClientKeepAlive: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../src/services/proxy.js', () => ({
  createFetchWithProxy: jest.fn(() => jest.fn()),
  getProxyConfigFromEnv: jest.fn(() => undefined),
}));

const mockServerDao = {
  findAll: jest.fn(async () => []),
  findById: jest.fn(async () => ({
    name: 'iso-server',
    type: 'streamable-http',
    url: 'https://example.com/mcp',
    enabled: true,
    perSessionClient: true,
  })),
};

jest.mock('../../src/dao/index.js', () => ({
  getServerDao: jest.fn(() => mockServerDao),
  getGroupDao: jest.fn(() => ({
    findByName: jest.fn(async () => null),
    findById: jest.fn(async () => null),
  })),
  getSystemConfigDao: jest.fn(() => ({
    get: jest.fn(async () => ({})),
  })),
  getBuiltinPromptDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
    findByName: jest.fn(async () => null),
    findByUri: jest.fn(async () => null),
  })),
  getBuiltinResourceDao: jest.fn(() => ({
    findEnabled: jest.fn(async () => []),
    findByName: jest.fn(async () => null),
    findByUri: jest.fn(async () => null),
  })),
  getUserDao: jest.fn(() => ({
    findByUsername: jest.fn(async () => null),
  })),
}));

jest.mock('../../src/config/index.js', () => ({
  expandEnvVars: jest.fn((value: string) => value),
  replaceEnvVars: jest.fn((value: any) => value),
  getNameSeparator: jest.fn(() => '::'),
  default: {
    mcpHubName: 'test-hub',
    mcpHubVersion: '1.0.0',
    initTimeout: 60000,
  },
}));

import * as mcpService from '../../src/services/mcpService.js';
import * as hostBridge from '../../src/utils/hostBridgeTransport.js';
import { RequestContextService } from '../../src/services/requestContextService.js';

const stateHandle = '65b523af-e4d0-4d99-8e06-461a62a14967';
const modernCall = (scope = 'credential-A', handle: string | string[] | undefined = stateHandle) =>
  RequestContextService.getInstance().runWithCustomRequestContext(
    { headers: { 'x-mcphub-state-id': handle }, stateless: true, clientStateScope: scope },
    () => callTool(''),
  );

const modernOpenAiSessionCall = (session: unknown, scope = 'credential-A') =>
  RequestContextService.getInstance().runWithCustomRequestContext(
    { headers: {}, stateless: true, clientStateScope: scope },
    () => callTool('', { 'openai/session': session }),
  );

// The SIGKILL fallback probes liveness with process.kill(pid, 0). Force it to
// report "dead" (ESRCH) for our fake pid so the 2s SIGKILL timer never fires.
const originalProcessKill = process.kill.bind(process);
const installProcessKillMock = (): void => {
  jest.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
    if (pid === 4242 && (signal === 0 || signal === undefined)) {
      throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' });
    }
    return originalProcessKill(pid, signal as any);
  }) as any);
};

type IsolatedConfig = Record<string, unknown>;

const makeServerInfo = (config: IsolatedConfig) => {
  // The shared client must never be used for a perSessionClient server; give it a
  // spy so tests can assert isolation.
  const sharedClient = {
    callTool: jest.fn().mockResolvedValue(makeOkResult()),
    close: jest.fn(),
  };

  return {
    name: 'iso-server',
    status: 'connected',
    enabled: true,
    tools: [{ name: 'iso-server::do_thing' }],
    client: sharedClient,
    transport: new MockStreamableHTTPClientTransport(new URL('https://example.com/mcp')),
    options: {},
    config: {
      name: 'iso-server',
      type: 'streamable-http',
      url: 'https://example.com/mcp',
      enabled: true,
      ...config,
    },
    sharedClient,
  } as any;
};

const callTool = (sessionId: string, meta?: Record<string, unknown>) =>
  mcpService.handleCallToolRequest(
    {
      params: {
        name: 'call_tool',
        arguments: {
          toolName: 'iso-server::do_thing',
          arguments: {},
        },
        ...(meta ? { _meta: meta } : {}),
      },
    },
    { sessionId, server: 'iso-server' },
  );

jest.mock('../../src/utils/stdioProcessCleanup.js', () => ({
  closeTrackedStdioProcessTree: jest.fn(async (_pid: number, close: () => Promise<void>) =>
    close(),
  ),
}));

describe('opt-in retained runtime integration', () => {
  let definition: any;
  let info: any;
  const inScope = <T>(
    operation: () => T,
    session = 'transport-A',
    scope = 'credential/principal/route',
  ) =>
    RequestContextService.getInstance().runWithCustomRequestContext(
      { headers: {}, clientStateScope: scope, sessionId: session, group: 'iso-server' },
      operation,
    );
  const invoke = (session = 'transport-A', scope = 'credential/principal/route') =>
    inScope(
      () =>
        mcpService.handleCallToolRequest(
          { params: { name: 'do_thing', arguments: {} } },
          { sessionId: session },
        ),
      session,
      scope,
    );
  const control = (
    name: string,
    args = {},
    session = 'transport-A',
    scope = 'credential/principal/route',
  ) =>
    inScope(
      () =>
        mcpService.handleCallToolRequest(
          { params: { name, arguments: args } },
          { sessionId: session },
        ),
      session,
      scope,
    );
  const payload = (result: any) => JSON.parse(result.content[0].text);

  beforeEach(async () => {
    await mcpService.cleanupAllServers();
    jest.clearAllMocks();
    mockCreatedClients.length = 0;
    mockCreatedTransports.length = 0;
    mockConnectBehavior = undefined;
    installProcessKillMock();
    definition = {
      name: 'iso-server',
      type: 'stdio',
      command: 'node',
      retentionPolicy: 'explicit',
      enabled: true,
    };
    mockServerDao.findById.mockImplementation(async () => definition);
    mockServerDao.findAll.mockImplementation(async () => [definition] as any);
    info = makeServerInfo(definition);
    info.status = 'disconnected';
    info.client = undefined;
    info.transport = undefined;
    info.prompts = [{ name: 'iso-server::prompt' }];
    info.resources = [{ uri: 'test://resource', name: 'resource' }];
    mcpService.setServerInfosForTest([info]);
  });
  afterEach(async () => {
    await mcpService.cleanupAllServers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  test('keeps bare upstream names on a direct no-Apps route and exposes controls without spawning', async () => {
    const result = await inScope(() =>
      mcpService.handleListToolsRequest({}, { sessionId: 'transport-A' }),
    );
    expect(result.tools.map((tool: any) => tool.name)).toEqual(
      expect.arrayContaining([
        'do_thing',
        'mcphub_runtime_list',
        'mcphub_runtime_release',
        'mcphub_catalog_status',
        'mcphub_catalog_refresh',
      ]),
    );
    expect(result.tools.some((tool: any) => tool.name === 'iso-server::do_thing')).toBe(false);
    expect(mockCreatedClients).toHaveLength(0);
    expect((await invoke()).isError).not.toBe(true);
    expect(mockCreatedClients).toHaveLength(1);
    expect(mockCreatedClients[0].callTool.mock.calls[0][0].name).toBe('do_thing');
    expect(info.sharedClient.callTool).not.toHaveBeenCalled();
    expect(info.config).toEqual(
      expect.objectContaining({ perSessionClient: true, startOnDemand: true }),
    );
  });

  test('retains detached explicit owners beyond 30 minutes and inventories them from a new transport', async () => {
    jest.useFakeTimers();
    await invoke();
    const first = payload(await control('mcphub_runtime_list'))[0];
    mcpService.deleteMcpServer('transport-A');
    await jest.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
    const detached = payload(await control('mcphub_runtime_list', {}, 'transport-B'));
    expect(detached[0]).toEqual(
      expect.objectContaining({ ownerId: first.ownerId, detachedAt: expect.any(Number) }),
    );
    await invoke('transport-B');
    expect(mockCreatedClients).toHaveLength(2);
    expect(
      payload(
        await control('mcphub_runtime_release', { owner_id: first.ownerId }, 'transport-B'),
      )[0].status,
    ).toBe('released');
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
    expect(mockCreatedClients[1].close).not.toHaveBeenCalled();
  });

  test('isolates credentials and denies cross-scope owner release', async () => {
    await invoke();
    const first = payload(await control('mcphub_runtime_list'))[0];
    await invoke('transport-A', 'another-credential');
    expect(mockCreatedClients).toHaveLength(2);
    expect(
      (
        await control(
          'mcphub_runtime_release',
          { owner_id: first.ownerId },
          'transport-A',
          'another-credential',
        )
      ).isError,
    ).toBe(true);
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
  });

  test('drains an active tool before release and rejects a new call while releasing', async () => {
    await invoke();
    let finish!: (value: any) => void;
    mockCreatedClients[0].callTool.mockImplementation(
      () => new Promise((resolve) => (finish = resolve)),
    );
    const active = invoke();
    await new Promise((resolve) => setImmediate(resolve));
    const result = payload(await control('mcphub_runtime_release'));
    expect(result[0].status).toBe('releasing');
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
    expect((await invoke()).isError).toBe(true);
    finish(makeOkResult());
    await active;
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
  });

  test('drains a release requested while the owned upstream is still connecting', async () => {
    let finishConnect!: () => void;
    mockConnectBehavior = () => new Promise<void>((resolve) => (finishConnect = resolve));
    const pending = invoke();
    await new Promise((resolve) => setImmediate(resolve));
    expect(payload(await control('mcphub_runtime_release'))[0].status).toBe('releasing');
    expect((await invoke()).isError).toBe(true);
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
    finishConnect();
    expect((await pending).isError).not.toBe(true);
    await new Promise((resolve) => setImmediate(resolve));
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
  });

  test('keeps a failed close visible and retries deliberate release', async () => {
    await invoke();
    const transport = mockCreatedTransports.find(
      (item) => item instanceof MockStdioClientTransport,
    );
    transport.close.mockRejectedValueOnce(new Error('transport close failed'));
    expect(payload(await control('mcphub_runtime_release'))[0].status).toBe('close_failed');
    expect(payload(await control('mcphub_runtime_list'))[0].status).toBe('close_failed');
    expect((await invoke()).isError).toBe(true);
    expect(payload(await control('mcphub_runtime_release'))[0].status).toBe('released');
  });

  test('preserves close_failed when the host bridge cannot verify owned cleanup', async () => {
    await invoke();
    const transport = mockCreatedTransports.find((item) => item instanceof MockStdioClientTransport);
    jest.spyOn(hostBridge, 'isHostBridgeTransport').mockImplementation((item) => item === transport);
    transport.close.mockRejectedValueOnce(new Error('Host MCP cleanup was not verified'));
    expect(payload(await control('mcphub_runtime_release'))[0].status).toBe('close_failed');
    expect(payload(await control('mcphub_runtime_list'))[0].status).toBe('close_failed');
    expect((await invoke()).isError).toBe(true);
    expect(payload(await control('mcphub_runtime_release'))[0].status).toBe('released');
  });

  test('starts idle expiry after prompt/resource work, using the same owner client', async () => {
    definition.retentionPolicy = 'idle';
    definition.idleTimeoutMs = 1000;
    info.config = definition;
    jest.useFakeTimers();
    const prompt = await inScope(() =>
      mcpService.handleGetPromptRequest(
        { params: { name: 'iso-server::prompt' } },
        { sessionId: 'transport-A' },
      ),
    );
    expect(prompt.messages).toEqual([]);
    await jest.advanceTimersByTimeAsync(900);
    const read = await inScope(() =>
      mcpService.handleReadResourceRequest(
        { params: { uri: 'test://resource' } },
        { sessionId: 'transport-A' },
      ),
    );
    expect(read.contents[0].text).toBe('state');
    expect(mockCreatedClients).toHaveLength(1);
    expect(mockCreatedClients[0].getPrompt).toHaveBeenCalledTimes(1);
    expect(mockCreatedClients[0].readResource).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(999);
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
  });

  test('waits for automatic idle cleanup before restarting instead of rejecting the next call', async () => {
    definition.retentionPolicy = 'idle';
    definition.idleTimeoutMs = 1000;
    info.config = definition;
    jest.useFakeTimers();
    await invoke();
    let finishClose!: () => void;
    mockCreatedClients[0].close.mockImplementationOnce(
      () => new Promise<void>((resolve) => (finishClose = resolve)),
    );
    await jest.advanceTimersByTimeAsync(1000);
    const next = invoke();
    await jest.advanceTimersByTimeAsync(0);
    expect(mockCreatedClients).toHaveLength(1);
    finishClose();
    expect((await next).isError).not.toBe(true);
    expect(mockCreatedClients).toHaveLength(2);
  });

  test('does not route opted-in modern owners through the 30-minute client-state sweep', async () => {
    jest.useFakeTimers();
    const result = await RequestContextService.getInstance().runWithCustomRequestContext(
      {
        headers: { 'x-mcphub-state-id': stateHandle },
        stateless: true,
        clientStateScope: 'modern-scope',
        group: 'iso-server',
      },
      () => mcpService.handleCallToolRequest({ params: { name: 'do_thing' } }, {}),
    );
    expect(result.isError).not.toBe(true);
    await jest.advanceTimersByTimeAsync(31 * 60 * 1000);
    expect(mockCreatedClients[0].close).not.toHaveBeenCalled();
  });

  test('invalidates existing owners when the persisted server configuration changes', async () => {
    await invoke();
    definition.env = { VERSION: 'changed' };
    await control('mcphub_runtime_list');
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
    const listed = await inScope(() =>
      mcpService.handleListToolsRequest({}, { sessionId: 'transport-A' }),
    );
    expect(listed.tools.some((tool: any) => tool.name === 'do_thing')).toBe(false);
    expect((await invoke()).isError).toBe(true);
    expect(mockCreatedClients).toHaveLength(1);
  });

  test('preserves memory discovery across description, visibility and tool projection edits', async () => {
    await invoke();
    const previousTools = info.tools;
    definition.description = 'Updated management note';
    definition.visibility = 'public';
    definition.tools = {
      'iso-server::do_thing': { enabled: true, description: 'Updated tool description' },
    };
    const listed = await inScope(() =>
      mcpService.handleListToolsRequest({}, { sessionId: 'transport-A' }),
    );
    expect(info.tools).toBe(previousTools);
    expect(listed.tools.find((tool: any) => tool.name === 'do_thing')?.description).toBe(
      'Updated tool description',
    );
    expect(info.prompts).toHaveLength(1);
    expect(info.resources).toHaveLength(1);
    expect(mockCreatedClients).toHaveLength(1);
    expect(mockCreatedClients[0].close).toHaveBeenCalledTimes(1);
    definition.tools['iso-server::do_thing'].enabled = false;
    const disabled = await inScope(() =>
      mcpService.handleListToolsRequest({}, { sessionId: 'transport-A' }),
    );
    expect(disabled.tools.some((tool: any) => tool.name === 'do_thing')).toBe(false);
    expect(info.tools).toBe(previousTools);
    expect(mockCreatedClients).toHaveLength(1);
  });

  test.each([
    { type: 'streamable-http', url: 'https://example.com' },
    { credentialTemplate: [{ target: 'env', name: 'TOKEN' }] },
    { passthroughHeaders: ['authorization'] },
  ])('fails closed for unsupported retained configuration %p', async (unsupported) => {
    Object.assign(definition, unsupported);
    expect((await invoke()).isError).toBe(true);
    expect(info.error).toContain('shared stdio');
    expect(mockCreatedClients).toHaveLength(0);
  });

  test('rejects missing verified credential scope without sharing a fallback runtime', async () => {
    const result = await RequestContextService.getInstance().runWithCustomRequestContext(
      { headers: {}, group: 'iso-server' },
      () =>
        mcpService.handleCallToolRequest(
          { params: { name: 'do_thing' } },
          { sessionId: 'transport-A' },
        ),
    );
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('verified bearer');
    expect(mockCreatedClients).toHaveLength(0);
  });
});
