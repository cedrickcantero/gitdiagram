import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  MAX_INCLUDED_FILE_TREE_CHARACTERS,
  MAX_README_BYTES,
  REPOSITORY_TOO_LARGE_ERROR,
  shouldIncludeFile,
  type GithubData,
  type RepositoryPathType,
  type SourceBlob,
} from "./github";
import { MAX_SOURCE_FILE_BYTES } from "./repository-context";
import type { SourceExcerpt, SourceReader } from "./source-context";

/** Reserved owner segment. `/local/<name>` addresses a repository on disk. */
export const LOCAL_REPO_OWNER = "local";

// Messages this module authors itself. They are echoed to the caller and
// persisted into a shared session audit, so none of them may contain a
// filesystem path. "Not found" and "outside the root" deliberately share one
// message so a response cannot be used to probe what exists on disk.
export const INVALID_LOCAL_REPO_NAME_ERROR = "Invalid local repository name.";
export const LOCAL_REPO_NOT_FOUND_ERROR = "Local repository not found.";
export const LOCAL_REPO_NOT_GIT_ERROR = "Not a git repository.";
export const LOCAL_REPO_NO_COMMITS_ERROR = "Local repository has no commits.";
export const LOCAL_REPO_EMPTY_ERROR =
  "Local repository has no analyzable files.";
export const LOCAL_REPO_READ_FAILED_ERROR =
  "Could not read the local repository.";

/**
 * Local mode needs an explicit opt-in AND a non-production build. Requiring
 * both means a stray environment variable on a deployed instance cannot expose
 * that server's filesystem under `/local/*`.
 */
export function isLocalRepoEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    Boolean(process.env.LOCAL_REPO_ROOT?.trim())
  );
}

/**
 * Maps a URL segment to an absolute repository path, or throws.
 *
 * This is the security boundary for the whole module. Resolving both sides
 * with realpath before comparing is what defeats a symlink inside the root
 * that points outside it; comparing the unresolved join would not.
 */
export async function resolveLocalRepoPath(name: string): Promise<string> {
  const trimmed = name.trim();
  // A leading dot also covers ".." and ".git"; a traversal with a separator is
  // caught by the separator checks.
  if (
    !trimmed ||
    trimmed.startsWith(".") ||
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("\0")
  ) {
    throw new Error(INVALID_LOCAL_REPO_NAME_ERROR);
  }

  const configuredRoot = process.env.LOCAL_REPO_ROOT?.trim();
  if (!configuredRoot) {
    throw new Error(LOCAL_REPO_NOT_FOUND_ERROR);
  }

  let repoPath: string;
  try {
    const root = await realpath(resolve(configuredRoot));
    repoPath = await realpath(join(root, trimmed));
    if (dirname(repoPath) !== root) {
      throw new Error(LOCAL_REPO_NOT_FOUND_ERROR);
    }
  } catch {
    throw new Error(LOCAL_REPO_NOT_FOUND_ERROR);
  }

  try {
    await stat(join(repoPath, ".git"));
  } catch {
    throw new Error(LOCAL_REPO_NOT_GIT_ERROR);
  }

  return repoPath;
}

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 10_000;
// Must comfortably exceed MAX_INCLUDED_FILE_TREE_CHARACTERS so an oversized
// tree is rejected by our own limit with its own message, rather than by
// execFile truncating the pipe.
const MAX_GIT_OUTPUT_BYTES = 16 * 1024 * 1024;
const README_PATTERN = /^readme(\.[^./]+)?$/i;

/**
 * Runs one git command against a resolved repository path.
 *
 * Caller cancellation must keep its own meaning, so an abort is rethrown
 * unchanged; every other failure collapses to one message that cannot leak a
 * path or git's own stderr.
 */
export async function runGit(
  repoPath: string,
  args: string[],
  signal?: AbortSignal,
): Promise<Buffer> {
  try {
    const { stdout } = await execFileAsync("git", ["-C", repoPath, ...args], {
      signal,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_GIT_OUTPUT_BYTES,
      encoding: "buffer",
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(LOCAL_REPO_READ_FAILED_ERROR, { cause: error });
  }
}

interface LocalTreeEntry {
  mode: string;
  type: string;
  sha: string;
  size: number;
  path: string;
}

/**
 * Parses `ls-tree -r -l -z` output. The -z form is NUL-terminated and leaves
 * paths unquoted, so a path containing a space, quote, or non-ASCII byte
 * survives intact.
 */
function parseLsTree(stdout: Buffer): LocalTreeEntry[] {
  const entries: LocalTreeEntry[] = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    if (!record) continue;
    const tab = record.indexOf("\t");
    if (tab === -1) continue;
    const fields = record.slice(0, tab).split(/\s+/);
    if (fields.length < 4) continue;
    const [mode, type, sha, rawSize] = fields as [
      string,
      string,
      string,
      string,
    ];
    entries.push({
      mode,
      type,
      sha,
      size: Number.parseInt(rawSize, 10),
      path: record.slice(tab + 1),
    });
  }
  return entries;
}

async function readReadme(
  repoPath: string,
  entries: LocalTreeEntry[],
  signal?: AbortSignal,
): Promise<string> {
  const entry = entries.find(
    (candidate) =>
      !candidate.path.includes("/") && README_PATTERN.test(candidate.path),
  );
  if (!entry || entry.size > MAX_README_BYTES) return "";
  const bytes = await runGit(
    repoPath,
    ["cat-file", "blob", entry.sha],
    signal,
  );
  if (bytes.length > MAX_README_BYTES) return "";
  return bytes.toString("utf8");
}

/**
 * Reads a local repository at committed HEAD and shapes it exactly like the
 * GitHub provider's output, so nothing downstream can tell the difference.
 *
 * Returns the resolved path alongside the data because the caller needs it to
 * build the matching source reader, and resolution is the security boundary
 * that should happen exactly once per request.
 */
export async function loadLocalRepository(
  name: string,
  signal?: AbortSignal,
): Promise<{ repoPath: string; data: GithubData }> {
  // resolveLocalRepoPath only checks LOCAL_REPO_ROOT, not NODE_ENV. Gating
  // here too means this exported entry point cannot read the filesystem in a
  // production build even if the env var were ever set there.
  if (!isLocalRepoEnabled()) throw new Error(LOCAL_REPO_NOT_FOUND_ERROR);

  const repoPath = await resolveLocalRepoPath(name);

  try {
    await runGit(repoPath, ["rev-parse", "--verify", "HEAD"], signal);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(LOCAL_REPO_NO_COMMITS_ERROR, { cause: error });
  }

  const branchOutput = await runGit(
    repoPath,
    ["rev-parse", "--abbrev-ref", "HEAD"],
    signal,
  );
  // A detached HEAD reports the literal "HEAD", which is a fine label here:
  // the field only ever feeds a display string on the local path.
  const defaultBranch = branchOutput.toString("utf8").trim() || "HEAD";

  const entries = parseLsTree(
    await runGit(repoPath, ["ls-tree", "-r", "-l", "-z", "HEAD"], signal),
  );

  const paths: string[] = [];
  const pathTypes = new Map<string, RepositoryPathType>();
  const sourceBlobs = new Map<string, SourceBlob>();
  for (const entry of entries) {
    if (entry.type !== "blob" || !shouldIncludeFile(entry.path)) continue;
    paths.push(entry.path);
    pathTypes.set(entry.path, "blob");
    if (
      (entry.mode === "100644" || entry.mode === "100755") &&
      /^[a-f0-9]{40,64}$/.test(entry.sha) &&
      Number.isFinite(entry.size) &&
      entry.size >= 0
    ) {
      sourceBlobs.set(entry.path, { sha: entry.sha, size: entry.size });
    }
  }

  if (!paths.length) throw new Error(LOCAL_REPO_EMPTY_ERROR);

  const fileTree = paths.join("\n");
  if (fileTree.length > MAX_INCLUDED_FILE_TREE_CHARACTERS) {
    throw new Error(REPOSITORY_TOO_LARGE_ERROR);
  }

  return {
    repoPath,
    data: {
      defaultBranch,
      fileTree,
      readme: await readReadme(repoPath, entries, signal),
      isPrivate: false,
      stargazerCount: null,
      pathTypes,
      sourceBlobs,
    },
  };
}

/**
 * Reads file bodies out of the local object store.
 *
 * No hash verification here, unlike the GitHub readers: `cat-file blob <sha>`
 * is content-addressed, so a returned body cannot disagree with the SHA that
 * requested it. The GitHub readers verify because their transport can serve a
 * different revision than the tree named.
 */
export function createLocalSourceReader(repoPath: string): SourceReader {
  return async ({ path, blob, signal }): Promise<SourceExcerpt | null> => {
    if (blob.size > MAX_SOURCE_FILE_BYTES) return null;

    const bytes = await runGit(
      repoPath,
      ["cat-file", "blob", blob.sha],
      signal,
    );
    if (bytes.length > MAX_SOURCE_FILE_BYTES || bytes.includes(0)) return null;

    try {
      return {
        path,
        text: new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        truncated: false,
      };
    } catch {
      return null;
    }
  };
}
