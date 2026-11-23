import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { paymentServer } from '../../dist/packages/fixtures/server.js';
const server = paymentServer('safe', process.argv[2], 0, true);
await server.connect(new StdioServerTransport());
