import { Server } from '@modelcontextprotocol/sdk-v1/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk-v1/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk-v1/types.js';

// Keep a real v1 upstream independent of the gateway's v2 server implementation.
const server = new Server(
  { name: 'transport-fixture', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'get_current_time',
      description: 'Return the current UTC time for transport integration tests.',
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== 'get_current_time') throw new Error('Unknown fixture tool');
  return { content: [{ type: 'text', text: new Date().toISOString() }] };
});

await server.connect(new StdioServerTransport());
