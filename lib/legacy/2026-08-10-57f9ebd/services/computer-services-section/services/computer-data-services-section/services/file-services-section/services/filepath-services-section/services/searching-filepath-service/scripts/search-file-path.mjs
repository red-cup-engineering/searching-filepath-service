#!/usr/bin/env node
import { createDatedStateCustody } from "@red-cup-engineering/dated-state-writing-service";

import { resolvePriorityPathsConfig, stagedTokenSearch } from "../src/search-file-path.mjs";

function usage() {
  return [
    "usage: search-file-path <token> --root <path> [--config <path>]",
    "         [--exclude <name>]... [--case-sensitive] [--word-boundary]",
    "         [--record <state-root>]",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { token: undefined, root: undefined, config: undefined, exclude: [], caseSensitive: false, wordBoundary: false, record: undefined };
  const rest = [...argv];
  while (rest.length > 0) {
    const arg = rest.shift();
    switch (arg) {
      case "--root":
        args.root = rest.shift();
        break;
      case "--config":
        args.config = rest.shift();
        break;
      case "--exclude":
        args.exclude.push(rest.shift());
        break;
      case "--case-sensitive":
        args.caseSensitive = true;
        break;
      case "--word-boundary":
        args.wordBoundary = true;
        break;
      case "--record":
        args.record = rest.shift();
        break;
      default:
        if (args.token === undefined) args.token = arg;
        else throw new TypeError(`unrecognized argument: ${arg}`);
    }
  }
  if (!args.token) throw new TypeError(`token is required\n${usage()}`);
  if (!args.root) throw new TypeError(`--root is required\n${usage()}`);
  if (args.record !== undefined && !args.record) throw new TypeError(`--record requires a state-root path\n${usage()}`);
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = await resolvePriorityPathsConfig({ root: args.root, configPath: args.config });
  const excludes = [...config.excludes, ...args.exclude];
  const options = { caseSensitive: args.caseSensitive, wordBoundary: args.wordBoundary };

  let custody = null;
  let recordedAt = null;
  if (args.record) {
    custody = createDatedStateCustody({ root: args.record });
    recordedAt = new Date().toISOString();
  }

  for await (const match of stagedTokenSearch({ token: args.token, root: args.root, priorityPaths: config.priorityPaths, excludes, options })) {
    const line = `${JSON.stringify(match)}\n`;
    const canWriteMore = process.stdout.write(line);
    if (custody) {
      await custody.put({ service: "searching-filepath-service", type: "run", extension: "ndjson", recordedAt, bytes: line, append: true });
    }
    if (!canWriteMore) await new Promise((res) => process.stdout.once("drain", res));
  }
}

// A downstream reader that stops early (`... | head -n 1`) closes its end of
// the pipe; Node then delivers EPIPE on the next stdout write. That is this
// tool's whole point working as designed (a caller reading the first line
// and stopping), not a failure — exit cleanly instead of an uncaught-error
// stack trace.
process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
  throw error;
});

main().catch((error) => {
  process.stderr.write(`${error.stack ?? error.message}\n`);
  process.exitCode = 1;
});
