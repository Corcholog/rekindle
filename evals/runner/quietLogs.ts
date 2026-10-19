// Imported first by the eval CLI: the pipeline's info logs (one line per stage and project) would
// bury the runner's progress lines. LOG_LEVEL still overrides.
process.env.LOG_LEVEL ??= 'warn';
