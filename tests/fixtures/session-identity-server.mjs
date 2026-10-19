import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';

const instance = randomUUID();
let calls = 0;
const server = new Server(
  { name: 'session-identity-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'probe_identity',
      description: 'Return this isolated test process identity and its call counter.',
      inputSchema: {
        type: 'object',
        properties: {
          label: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,32}$' },
          delayMs: { type: 'integer', minimum: 0, maximum: 30000 },
        },
        required: ['label'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
  ],
}));
server.setRequestHandler('tools/call', async (request) => {
  const label = request.params.arguments?.label;
  if (
    request.params.name !== 'probe_identity' ||
    typeof label !== 'string' ||
    !/^[A-Za-z0-9_-]{1,32}$/.test(label)
  ) {
    throw new Error('Use probe_identity with a short alphanumeric test label');
  }
  const delayMs = request.params.arguments?.delayMs ?? 0;
  if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 30000) {
    throw new Error('delayMs must be an integer between 0 and 30000');
  }
  if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
  return {
    content: [
      { type: 'text', text: JSON.stringify({ instance, pid: process.pid, calls: ++calls, label }) },
    ],
  };
});
await server.connect(new StdioServerTransport());
