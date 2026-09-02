#!/usr/bin/env node
import { run } from './cli';
import { CliError } from './util/errors';
import { color } from './util/ansi';

run(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    if (err instanceof CliError) {
      process.stderr.write(color.red(`error: ${err.message}`) + '\n');
      if (err.hint) process.stderr.write(color.dim(err.hint) + '\n');
      process.exitCode = err.exitCode;
      return;
    }
    const message = err instanceof Error ? err.stack ?? err.message : String(err);
    process.stderr.write(color.red('unexpected error:') + '\n' + message + '\n');
    process.exitCode = 1;
  });
