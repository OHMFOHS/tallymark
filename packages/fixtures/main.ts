import { serve } from './server.js';
serve(...(process.argv.slice(2) as [string, string, string?, string?])).catch(
  () => {
    process.stderr.write(
      'Fixture startup failed. Supply a mode and writable ledger path.\n',
    );
    process.exitCode = 2;
  },
);
