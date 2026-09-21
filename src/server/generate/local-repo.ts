import { realpath, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

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
