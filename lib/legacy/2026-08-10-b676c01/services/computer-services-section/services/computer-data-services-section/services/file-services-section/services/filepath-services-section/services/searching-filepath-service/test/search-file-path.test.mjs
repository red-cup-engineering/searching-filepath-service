import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { resolvePriorityPathsConfig, stagedTokenSearch } from "../src/search-file-path.mjs";

async function withRoot(fn) {
  const root = await mkdtemp(join(tmpdir(), "search-path-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function buildFixture(root) {
  await mkdir(join(root, "content", "witness-journal-project"), { recursive: true });
  await mkdir(join(root, "other"), { recursive: true });
  await writeFile(
    join(root, "content", "witness-journal-project", "README.md"),
    "---\ntitle: WitnessJournal Overview\n---\n# Notes\n\nBody text.\n\n## WitnessJournal Deep Dive\n\nMore text.\n",
  );
  await writeFile(join(root, "other", "witness-journal-notes.md"), "# Just some notes\n\nNo relevant heading here.\n");
  await writeFile(join(root, "other", "unrelated.md"), "# Unrelated\n\nNothing here.\n");
}

test("resolvePriorityPathsConfig reads an explicit --config path", async () => {
  await withRoot(async (root) => {
    const configPath = join(root, "custom-config.json");
    await writeFile(configPath, JSON.stringify({ priorityPaths: ["a"], excludes: ["b"] }));
    const config = await resolvePriorityPathsConfig({ root, configPath });
    assert.deepEqual(config.priorityPaths, ["a"]);
    assert.deepEqual(config.excludes, ["b"]);
    assert.equal(config.sourcePath, configPath);
  });
});

test("resolvePriorityPathsConfig throws when the explicit --config path does not exist", async () => {
  await withRoot(async (root) => {
    await assert.rejects(() => resolvePriorityPathsConfig({ root, configPath: join(root, "missing.json") }));
  });
});

test("resolvePriorityPathsConfig prefers <root>/etc/priority-paths.json over the shipped example", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "etc"), { recursive: true });
    await writeFile(join(root, "etc", "priority-paths.json"), JSON.stringify({ priorityPaths: ["content"], excludes: [] }));
    const config = await resolvePriorityPathsConfig({ root });
    assert.deepEqual(config.priorityPaths, ["content"]);
    assert.equal(config.sourcePath, join(root, "etc", "priority-paths.json"));
  });
});

test("resolvePriorityPathsConfig falls back to the shipped example when neither is present", async () => {
  await withRoot(async (root) => {
    const config = await resolvePriorityPathsConfig({ root });
    assert.ok(config.priorityPaths.length > 0);
    assert.ok(config.sourcePath.endsWith("priority-paths.example.json"));
  });
});

test("stagedTokenSearch yields matches strictly in ascending stage order", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["content"], excludes: [] })) {
      matches.push(match);
    }
    const stages = matches.map((m) => m.stage);
    const sorted = [...stages].sort((a, b) => a - b);
    assert.deepEqual(stages, sorted);
    assert.ok(stages.includes(1), "expected at least one stage-1 match");
    assert.ok(stages.includes(2), "expected at least one stage-2 match");
    assert.ok(stages.includes(3), "expected at least one stage-3 match");
    assert.ok(stages.includes(4), "expected at least one stage-4 match");
  });
});

test("stage 1 finds the priority-path directory-name hit by full path, not basename", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["content"], excludes: [] })) {
      matches.push(match);
    }
    const stage1 = matches.filter((m) => m.stage === 1);
    assert.ok(stage1.some((m) => m.path === "content/witness-journal-project/README.md"));
  });
});

test("stage 2 does not re-emit a file already covered by a single-segment priority path", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["content"], excludes: [] })) {
      matches.push(match);
    }
    const stage2Paths = matches.filter((m) => m.stage === 2).map((m) => m.path);
    assert.equal(stage2Paths.includes("content/witness-journal-project/README.md"), false);
    assert.ok(stage2Paths.includes("other/witness-journal-notes.md"));
  });
});

test("stage 3 carries the frontmatter-title hit and stage 4 carries the heading hit for the same document", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["content"], excludes: [] })) {
      matches.push(match);
    }
    const stage3 = matches.filter((m) => m.stage === 3);
    const stage4 = matches.filter((m) => m.stage === 4);
    assert.ok(stage3.some((m) => m.path === "content/witness-journal-project/README.md" && m.matchKind === "frontmatter-title"));
    assert.ok(stage4.some((m) => m.path === "content/witness-journal-project/README.md" && m.matchKind === "heading" && m.matchedText === "WitnessJournal Deep Dive"));
  });
});

test("a deep (multi-segment) priority path is walked in stage 1 and excluded from stage 2 by post-filter", async () => {
  await withRoot(async (root) => {
    await mkdir(join(root, "a", "b", "content"), { recursive: true });
    await writeFile(join(root, "a", "b", "content", "witness-journal-thing.md"), "# witness-journal-thing\n");
    await mkdir(join(root, "elsewhere"), { recursive: true });
    await writeFile(join(root, "elsewhere", "witness-journal-other.md"), "# witness-journal-other\n");

    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["a/b/content"], excludes: [] })) {
      matches.push(match);
    }
    const stage1Paths = matches.filter((m) => m.stage === 1).map((m) => m.path);
    const stage2Paths = matches.filter((m) => m.stage === 2).map((m) => m.path);
    assert.ok(stage1Paths.includes("a/b/content/witness-journal-thing.md"));
    assert.equal(stage2Paths.includes("a/b/content/witness-journal-thing.md"), false);
    assert.ok(stage2Paths.includes("elsewhere/witness-journal-other.md"));
  });
});

test("no priority paths configured still runs stage 2 and markdown stages over the whole root", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: [], excludes: [] })) {
      matches.push(match);
    }
    assert.equal(matches.some((m) => m.stage === 1), false);
    assert.ok(matches.some((m) => m.stage === 2 && m.path === "content/witness-journal-project/README.md"));
  });
});

test("a nonexistent configured priority path is skipped rather than throwing", async () => {
  await withRoot(async (root) => {
    await buildFixture(root);
    const matches = [];
    for await (const match of stagedTokenSearch({ token: "WitnessJournal", root, priorityPaths: ["does-not-exist", "content"], excludes: [] })) {
      matches.push(match);
    }
    assert.ok(matches.some((m) => m.stage === 1));
  });
});

test("throws when token is missing", async () => {
  await withRoot(async (root) => {
    await assert.rejects(async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of stagedTokenSearch({ root, priorityPaths: [] })) {
        // draining is enough to trigger the guard
      }
    }, TypeError);
  });
});
