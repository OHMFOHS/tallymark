import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const server = new Server(
  { name: 'task-only', version: '1' },
  { capabilities: { tools: {} } },
);
server.setRequestHandler('tools/list', async () => ({
  tools: [
    {
      name: 'background_job',
      inputSchema: { type: 'object' },
      execution: { taskSupport: 'required' },
    },
  ],
}));
await server.connect(new StdioServerTransport());
