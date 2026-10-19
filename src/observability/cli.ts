import { pool } from '../db';
import { buildReport, parseSince, pruneTelemetry, renderReport } from './report';
import { buildTrace, renderTrace } from './trace';

// pnpm telemetry:report [--since 7d] [--json]
// pnpm telemetry:trace <suggestionId|contentId>
// pnpm telemetry:prune --older-than 90d

const USAGE = `Usage:
  pnpm telemetry:report [--since 7d|24h|30m|<ISO date>] [--json]
  pnpm telemetry:trace <suggestionId|contentId>
  pnpm telemetry:prune --older-than <90d|...>   (deletes telemetry rows and pipeline events)`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv;
  if (command === 'report') {
    const report = await buildReport({ since: parseSince(flag(args, '--since') ?? '7d') });
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : renderReport(report));
    return 0;
  }
  if (command === 'trace') {
    const id = args[0];
    if (!id || !UUID.test(id)) {
      console.error(USAGE);
      return 1;
    }
    const view = await buildTrace(id);
    if (!view) {
      console.error(`No suggestion or content with ID ${id}`);
      return 1;
    }
    console.log(renderTrace(view));
    return 0;
  }
  if (command === 'prune') {
    const olderThan = flag(args, '--older-than');
    // Deleting needs an explicit age: there is no default
    if (!olderThan || !/^\d+d$/.test(olderThan) || Number(olderThan.slice(0, -1)) < 1) {
      console.error('telemetry:prune needs --older-than <days>d (at least 1d)');
      return 1;
    }
    const cutoff = parseSince(olderThan);
    const deleted = await pruneTelemetry(cutoff);
    console.log(`Deleted ${deleted.llmTelemetry} llm_telemetry rows and ${deleted.pipelineEvents} pipeline events older than ${cutoff.toISOString()}`);
    return 0;
  }
  console.error(USAGE);
  return 1;
}

main(process.argv.slice(2))
  .then(code => { process.exitCode = code; })
  .catch(err => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
