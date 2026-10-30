import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "scripts", "search-file-path.mjs");

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "search-path-bin-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildFixture(root) {
  await mkdir(join(root, "content", "witness-journal-project"), { recursive: true });
  await writeFile(
    join(root, "content", "witness-journal-project", "README.md"),
    "---\ntitle: WitnessJournal Overview\n---\n# Notes\n\n## WitnessJournal Deep Dive\n\ntext\n",
  );
  await mkdir(join(root, "etc"), { recursive: true });
  await writeFile(join(root, "etc", "priority-paths.json"), JSON.stringify({ priorityPaths: ["content"], excludes: [] }));
}

test("the bin streams NDJSON lines, each one valid JSON, in ascending stage order", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const result = spawnSync(process.execPath, [BIN, "WitnessJournal", "--root", root], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const lines = result.stdout.trim().split("\n").filter((l) => l.length > 0);
    assert.ok(lines.length > 0);
    const records = lines.map((line) => JSON.parse(line));
    const stages = records.map((r) => r.stage);
    assert.deepEqual(stages, [...stages].sort((a, b) => a - b));
    assert.ok(records.some((r) => r.stage === 1 && r.path === "content/witness-journal-project/README.md"));
  });
});

test("a missing token argument fails with a non-zero exit and a usage message", async () => {
  await withRoot(async (root) => {
    const result = spawnSync(process.execPath, [BIN, "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /token is required/);
  });
});
