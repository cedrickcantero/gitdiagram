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
 * Local mode needs an explicit opt-in, a non-production build, AND a
 * non-empty `R2_ENDPOINT`. Requiring the first two means a stray environment
 * variable on a deployed instance cannot expose that server's filesystem
 * under `/local/*`.
 *
 * The third condition exists for a different reason: a local generation's
 * diagram and README excerpt are written to whatever artifact bucket storage
 * is configured with, which is the same PUBLIC bucket a real deployment
 * uses. The design assumed that bucket is always local MinIO in development,
 * but nothing else enforces that, so a developer running this server against
 * real R2 credentials would publish a private, possibly unpushed repository's
 * diagram to a real public bucket. `R2_ENDPOINT` only has a value when
 * storage has been deliberately pointed at a local S3-compatible server (see
 * `src/server/storage/r2.ts`), so requiring it here keeps that publish local
 * too.
 */
export function isLocalRepoEnabled(): boolean {
  return (
    process.env.NODE_ENV !== "production" &&
    Boolean(process.env.LOCAL_REPO_ROOT?.trim()) &&
    Boolean(process.env.R2_ENDPOINT?.trim())
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
 * Thrown by `runGit` on any failure. `gitExitedNonZero` tells the caller
 * whether the git process actually started and produced an exit code (a real
 * answer about the repository, such as "no commits yet") versus a failure
 * where git never got that far: a spawn failure (git missing from PATH) or
 * the command timing out. Only the former is safe to reinterpret as a
 * specific repository state; the latter is a configuration problem on this
 * machine, not a fact about the repository, and must not be reported as one.
 */
class LocalGitCommandError extends Error {
  constructor(
    message: string,
    readonly gitExitedNonZero: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LocalGitCommandError";
  }
}

/**
 * Runs one git command against a resolved repository path.
 *
 * Caller cancellation must keep its own meaning, so an abort is rethrown
 * unchanged; every other failure collapses to one message that cannot leak a
 * path or git's own stderr to the caller. The real cause (git not on PATH, a
 * `safe.directory` refusal, a corrupt ref, the timeout, ...) is only ever
 * visible in the server log line this logs before rethrowing, which is the
 * one place a developer can diagnose it. An absolute repository path can
 * legitimately appear in that log line; it must simply never reach the
 * thrown message, and it does not.
 */
async function runGit(
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

    const execError = error as NodeJS.ErrnoException & {
      code?: number | string | null;
      killed?: boolean;
      stderr?: string | Buffer;
    };
    // execFile reports a numeric `code` only when the git process actually
    // ran to completion and exited non-zero. A spawn failure (e.g. ENOENT
    // when git is missing) reports a string error code instead, and a timeout
    // kills the process without ever assigning an exit code.
    const gitExitedNonZero = typeof execError.code === "number";
    const stderr = Buffer.isBuffer(execError.stderr)
      ? execError.stderr.toString("utf8")
      : (execError.stderr ?? "");

    console.error(
      JSON.stringify({
        event: "generate.local_repo.git_failed",
        subcommand: args[0] ?? null,
        exit_code: execError.code ?? null,
        killed: Boolean(execError.killed),
        stderr: stderr.slice(0, 500),
      }),
    );

    throw new LocalGitCommandError(
      LOCAL_REPO_READ_FAILED_ERROR,
      gitExitedNonZero,
      {
        cause: error,
      },
    );
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
 * Parses `ls-tree -r -t -l -z` output. The -z form is NUL-terminated and
 * leaves paths unquoted, so a path containing a space, quote, or non-ASCII
 * byte survives intact. A tree entry's size field prints as "-", which
 * `Number.parseInt` turns into `NaN` rather than throwing.
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
      candidate.type === "blob" &&
      !candidate.path.includes("/") &&
      README_PATTERN.test(candidate.path),
  );
  if (!entry || entry.size > MAX_README_BYTES) return "";
  const bytes = await runGit(repoPath, ["cat-file", "blob", entry.sha], signal);
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
    // Only a git process that actually ran and exited non-zero is a real
    // answer about this repository's state. A spawn failure or a timeout
    // never got that far, so it must surface as a read failure rather than
    // the misleading claim that the repository has no commits.
    if (error instanceof LocalGitCommandError && !error.gitExitedNonZero) {
      throw new Error(LOCAL_REPO_READ_FAILED_ERROR, { cause: error });
    }
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

  // -t adds directory entries alongside blobs, matching what the GitHub tree
  // builder receives from the trees API: both feed the same entry loop below
  // so a local prompt cannot differ in content from a GitHub one for the same
  // tree.
  const entries = parseLsTree(
    await runGit(repoPath, ["ls-tree", "-r", "-t", "-l", "-z", "HEAD"], signal),
  );

  const paths: string[] = [];
  const pathTypes = new Map<string, RepositoryPathType>();
  const sourceBlobs = new Map<string, SourceBlob>();
  for (const entry of entries) {
    if (!shouldIncludeFile(entry.path)) continue;
    paths.push(entry.path);
    // Mirrors github.ts's tree-processing loop exactly: pathTypes gets both
    // blob and tree entries (a gitlink/submodule "commit" entry gets neither),
    // and only a blob with a regular-file mode becomes a source candidate. A
    // tree entry's size field is "-", not a number, so it never survives the
    // Number.isFinite check below.
    if (entry.type === "blob" || entry.type === "tree") {
      pathTypes.set(entry.path, entry.type);
      if (
        entry.type === "blob" &&
        (entry.mode === "100644" || entry.mode === "100755") &&
        /^[a-f0-9]{40,64}$/.test(entry.sha) &&
        Number.isFinite(entry.size) &&
        entry.size >= 0
      ) {
        sourceBlobs.set(entry.path, { sha: entry.sha, size: entry.size });
      }
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
    // The reader is exported and its contract does not otherwise say the sha
    // must be a real object id. Without this, a sha beginning with "-" would
    // be parsed by cat-file as an option rather than an object. The `--`
    // below is a second, independent guard against the same class of input.
    if (!/^[a-f0-9]{40,64}$/.test(blob.sha)) return null;

    const bytes = await runGit(
      repoPath,
      ["cat-file", "blob", "--", blob.sha],
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
