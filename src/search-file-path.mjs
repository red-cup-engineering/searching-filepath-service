import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { walkPosixPaths } from "@red-cup-engineering/path-walking-service";
import { sliceFilesByType } from "@red-cup-engineering/file-type-slicing-service";
import { matchFilenameToken } from "@red-cup-engineering/filename-token-matching-service";
import { observeMarkdownDocumentIndex } from "@red-cup-engineering/markdown-engineering-services-section/observe-markdown-document-index";
import { matchMarkdownToken } from "@red-cup-engineering/markdown-engineering-services-section/match-markdown-token";

// This app's own shipped fallback config — always resolvable relative to
// this module's own file, regardless of the caller's cwd. Package.json
// carries no hardcoded priority-path or exclude values; this file is the
// documented-generic fallback of last resort (§3.2 of the design dossier).
const PACKAGE_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const SHIPPED_EXAMPLE_CONFIG_PATH = join(PACKAGE_DIR, "etc", "priority-paths.example.json");

async function readJsonIfPresent(path) {
  try {
    return { config: JSON.parse(await readFile(path, "utf8")), path };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * Resolve the priority-paths config for one search run. Resolution order:
 * an explicit --config path (required to exist if given), else
 * `<root>/etc/priority-paths.json` (a vault-local override — priority
 * content locations are a property of the tree being searched, not of the
 * machine running the search), else this package's own shipped
 * `etc/priority-paths.example.json` fallback, so the tool is never silently
 * unconfigured, only silently generic.
 */
export async function resolvePriorityPathsConfig({ root, configPath } = {}) {
  if (typeof root !== "string" || !root) throw new TypeError("root is required");

  if (typeof configPath === "string" && configPath) {
    const found = await readJsonIfPresent(resolve(configPath));
    if (found === null) throw new Error(`--config path does not exist: ${configPath}`);
    return freezeConfig(found.config, found.path);
  }

  const vaultLocal = await readJsonIfPresent(join(resolve(root), "etc", "priority-paths.json"));
  if (vaultLocal !== null) return freezeConfig(vaultLocal.config, vaultLocal.path);

  const shipped = await readJsonIfPresent(SHIPPED_EXAMPLE_CONFIG_PATH);
  if (shipped !== null) return freezeConfig(shipped.config, shipped.path);

  throw new Error("no priority-paths config found (checked --config, <root>/etc/priority-paths.json, and the shipped example)");
}

function freezeConfig(config, sourcePath) {
  return Object.freeze({
    type: "TokenSearchPriorityPaths",
    priorityPaths: Object.freeze([...(config.priorityPaths ?? [])]),
    excludes: Object.freeze([...(config.excludes ?? [])]),
    sourcePath,
  });
}

function rebaseFiles(files, prefix) {
  return files.map((file) => Object.freeze({ ...file, path: `${prefix}/${file.path}` }));
}

function isCoveredByDeepPriorityPath(path, deepPriorityPaths) {
  return deepPriorityPaths.some((priorityPath) => path === priorityPath || path.startsWith(`${priorityPath}/`));
}

/**
 * Run the four-stage staged token search and yield match records
 * (`{stage, path, matchKind, matchedText, score}`) in strict stage order,
 * flushing each stage before the next begins — the correctness property
 * this whole tool exists to provide, never broken for aggregate wall-clock
 * speed (see the design dossier §3.4).
 *
 * Stage 1: one walkPosixPaths call per configured priority path, matched
 *   and yielded before the next priority path's walk starts.
 * Stage 2: one walkPosixPaths call over the rest of root, excluding the
 *   already-covered priority segments (a single-segment priority path is
 *   dropped cheaply by walkPosixPaths' own segment-matcher excludes; a
 *   deeper priority path is walked again and its candidates are filtered
 *   out here instead — a documented, accepted cost asymmetry, not a second
 *   exclusion mechanism).
 * Stage 3 / 4: one shared markdown-document-index build over every markdown
 *   file seen in stages 1 and 2 combined (no third walk), then one matcher
 *   call split into frontmatter/title hits (stage 3) and heading hits
 *   (stage 4).
 */
export async function* stagedTokenSearch({ token, root, priorityPaths = [], excludes = [], options = {} } = {}) {
  if (typeof token !== "string" || token.trim() === "") throw new TypeError("token is required");
  if (typeof root !== "string" || !root) throw new TypeError("root is required");

  const absoluteRoot = resolve(root);
  const singleSegmentPriorityPaths = priorityPaths.filter((p) => !p.includes("/"));
  const deepPriorityPaths = priorityPaths.filter((p) => p.includes("/"));

  const seenFiles = [];

  // Stage 1 — one walk per priority path, flushed before the next starts.
  for (const priorityPath of priorityPaths) {
    let walk;
    try {
      walk = await walkPosixPaths({ root: join(absoluteRoot, priorityPath), excludes, digest: false });
    } catch (error) {
      if (error.code === "ENOENT") continue; // configured priority path does not exist under this root
      throw error;
    }
    const rebased = rebaseFiles(walk.files, priorityPath);
    seenFiles.push(...rebased);
    const matches = matchFilenameToken({ token, files: rebased, options });
    for (const match of matches) yield Object.freeze({ stage: 1, ...match });
  }

  // Stage 2 — one walk of the rest of root.
  const stage2Excludes = [...excludes, ...singleSegmentPriorityPaths];
  const walk2 = await walkPosixPaths({ root: absoluteRoot, excludes: stage2Excludes, digest: false });
  const stage2Files = walk2.files.filter((file) => !isCoveredByDeepPriorityPath(file.path, deepPriorityPaths));
  seenFiles.push(...stage2Files);
  const stage2Matches = matchFilenameToken({ token, files: stage2Files, options });
  for (const match of stage2Matches) yield Object.freeze({ stage: 2, ...match });

  // Stages 3/4 — one shared markdown index over every markdown file seen so
  // far (stage 1 + stage 2 combined cover the whole root already; no third
  // walk). sliceFilesByType is the existing pure-grouping precedent for
  // pulling ".md" paths back out of an already-walked file list.
  const readableFiles = seenFiles.filter((file) => file.kind === "file");
  const slice = sliceFilesByType({ files: readableFiles });
  const markdownPaths = slice.slices.md?.paths ?? [];

  const index = await observeMarkdownDocumentIndex({ paths: markdownPaths, root: absoluteRoot });
  const markdownMatches = matchMarkdownToken({ token, index, options });

  for (const match of markdownMatches.filter((m) => m.matchKind !== "heading")) yield Object.freeze({ stage: 3, ...match });
  for (const match of markdownMatches.filter((m) => m.matchKind === "heading")) yield Object.freeze({ stage: 4, ...match });
}
