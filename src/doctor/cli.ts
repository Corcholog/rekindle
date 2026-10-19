import 'dotenv/config';
import { parseEnv } from '../config';
import { hasFailures, renderChecks, runChecks } from './checks';
import { realProbes } from './probes';

async function main() {
  try {
    parseEnv(process.env);
  } catch (err) {
    // Zod reports which variable is wrong and why; it never echoes values
    console.error(`Invalid configuration: ${(err as Error).message}`);
    process.exit(1);
  }
  const results = await runChecks(await realProbes(process.env));
  console.log(renderChecks(results));
  process.exit(hasFailures(results) ? 1 : 0);
}

main();
