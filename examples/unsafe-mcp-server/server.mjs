import { serve } from '../../dist/packages/fixtures/server.js';
await serve('unsafe', process.argv[2]);
