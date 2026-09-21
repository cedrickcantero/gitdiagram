import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import {
  INVALID_LOCAL_REPO_NAME_ERROR,
  LOCAL_REPO_EMPTY_ERROR,
  LOCAL_REPO_NO_COMMITS_ERROR,
  LOCAL_REPO_NOT_FOUND_ERROR,
  LOCAL_REPO_NOT_GIT_ERROR,
  LOCAL_REPO_OWNER,
  isLocalRepoEnabled,
  loadLocalRepository,
  resolveLocalRepoPath,
} from "~/server/generate/local-repo";
import {
  MAX_INCLUDED_FILE_TREE_CHARACTERS,
  REPOSITORY_TOO_LARGE_ERROR,
} from "~/server/generate/github";

const execFileAsync = promisify(execFile);

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "gitdiagram-root-"));
  outside = await mkdtemp(join(tmpdir(), "gitdiagram-outside-"));
  // vi.stubEnv rather than assigning process.env directly: NODE_ENV is typed
  // readonly, and stubs unwind cleanly even if a case throws.
  vi.stubEnv("LOCAL_REPO_ROOT", root);
  vi.stubEnv("NODE_ENV", "development");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

async function makeRepoDir(name: string) {
  const path = join(root, name);
  await mkdir(join(path, ".git"), { recursive: true });
  return path;
}

async function initRepo(
  name: string,
  files: Record<string, string>,
): Promise<string> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  const git = (...args: string[]) => execFileAsync("git", ["-C", path, ...args]);
  await git("init", "-q");
  await git("config", "user.email", "test@example.com");
  await git("config", "user.name", "Test");
  await git("config", "commit.gpgsign", "false");
  for (const [file, contents] of Object.entries(files)) {
    const target = join(path, file);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents);
  }
  return path;
}

async function commitAll(path: string) {
  const git = (...args: string[]) => execFileAsync("git", ["-C", path, ...args]);
  await git("add", "-A");
  await git("commit", "-q", "-m", "initial");
}

describe("isLocalRepoEnabled", () => {
  it("is true in development with a root set", () => {
    expect(isLocalRepoEnabled()).toBe(true);
  });

  it("is false without a root", () => {
    vi.stubEnv("LOCAL_REPO_ROOT", undefined);
    expect(isLocalRepoEnabled()).toBe(false);
  });

  it("is false when the root is blank", () => {
    vi.stubEnv("LOCAL_REPO_ROOT", "   ");
    expect(isLocalRepoEnabled()).toBe(false);
  });

  it("is false in production even with a root set", () => {
    vi.stubEnv("NODE_ENV", "production");
    expect(isLocalRepoEnabled()).toBe(false);
  });
});

describe("LOCAL_REPO_OWNER", () => {
  it("is the reserved owner segment", () => {
    expect(LOCAL_REPO_OWNER).toBe("local");
  });
});

describe("resolveLocalRepoPath", () => {
  it("resolves a direct child that is a git repository", async () => {
    const path = await makeRepoDir("project");
    // realpath here (not a raw string compare) because os.tmpdir() sits under
    // a symlink on macOS (/var -> /private/var); resolveLocalRepoPath
    // correctly returns the resolved path, so the expectation must too. This
    // is a no-op on platforms where tmpdir is not itself a symlink.
    await expect(resolveLocalRepoPath("project")).resolves.toBe(
      await realpath(path),
    );
  });

  it.each([
    ["a path separator", "nested/project"],
    ["a backslash", "nested\\project"],
    ["a parent traversal", ".."],
    ["a leading dot", ".hidden"],
    ["an empty name", ""],
  ])("rejects %s", async (_label, name) => {
    await expect(resolveLocalRepoPath(name)).rejects.toThrow(
      INVALID_LOCAL_REPO_NAME_ERROR,
    );
  });

  it("reports a missing directory as not found", async () => {
    await expect(resolveLocalRepoPath("absent")).rejects.toThrow(
      LOCAL_REPO_NOT_FOUND_ERROR,
    );
  });

  it("rejects a symlink that escapes the root", async () => {
    await mkdir(join(outside, ".git"), { recursive: true });
    await symlink(outside, join(root, "escape"));
    await expect(resolveLocalRepoPath("escape")).rejects.toThrow(
      LOCAL_REPO_NOT_FOUND_ERROR,
    );
  });

  it("rejects a directory without .git", async () => {
    await mkdir(join(root, "plain"), { recursive: true });
    await expect(resolveLocalRepoPath("plain")).rejects.toThrow(
      LOCAL_REPO_NOT_GIT_ERROR,
    );
  });

  it("never leaks the absolute path in an error message", async () => {
    await mkdir(join(root, "plain"), { recursive: true });
    const names = ["absent", "plain", "..", "nested/project"];

    for (const name of names) {
      const error = await resolveLocalRepoPath(name).catch(
        (thrown: unknown) => thrown,
      );
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain(root);
      expect((error as Error).message).not.toContain(tmpdir());
    }
  });

  it("reports not found when no root is configured", async () => {
    vi.stubEnv("LOCAL_REPO_ROOT", undefined);
    await expect(resolveLocalRepoPath("project")).rejects.toThrow(
      LOCAL_REPO_NOT_FOUND_ERROR,
    );
  });
});

describe("loadLocalRepository", () => {
  it("builds a GithubData from the committed tree", async () => {
    const path = await initRepo("app", {
      "README.md": "# App\n\nDocs here.\n",
      "src/index.ts": "export const x = 1;\n",
      "src/util.ts": "export const y = 2;\n",
    });
    await commitAll(path);

    const { repoPath, data } = await loadLocalRepository("app");

    // realpath here for the same reason as the resolveLocalRepoPath tests
    // above: os.tmpdir() sits under a symlink on macOS (/var -> /private/var).
    expect(repoPath).toBe(await realpath(path));
    expect(data.isPrivate).toBe(false);
    expect(data.stargazerCount).toBeNull();
    expect(data.readme).toContain("# App");
    expect(data.fileTree.split("\n").sort()).toEqual([
      "README.md",
      "src/index.ts",
      "src/util.ts",
    ]);
    expect(data.pathTypes.get("src/index.ts")).toBe("blob");
    expect(data.sourceBlobs?.get("src/index.ts")?.sha).toMatch(/^[a-f0-9]{40}$/);
    expect(data.sourceBlobs?.get("src/index.ts")?.size).toBe(
      "export const x = 1;\n".length,
    );
  });

  it("produces blob SHAs that match git's own hash-object output", async () => {
    const path = await initRepo("hashes", { "a.ts": "export const a = 1;\n" });
    await commitAll(path);

    const { data } = await loadLocalRepository("hashes");
    const { stdout } = await execFileAsync("git", [
      "-C",
      path,
      "hash-object",
      "a.ts",
    ]);

    expect(data.sourceBlobs?.get("a.ts")?.sha).toBe(stdout.trim());
  });

  it("applies the same exclusion filter as the GitHub provider", async () => {
    const path = await initRepo("filtered", {
      "src/index.ts": "export const x = 1;\n",
      "node_modules/dep/index.js": "module.exports = 1;\n",
      "dist/bundle.min.js": "var a=1;\n",
    });
    await commitAll(path);

    const { data } = await loadLocalRepository("filtered");

    expect(data.fileTree).toBe("src/index.ts");
  });

  it("returns an empty readme when the repository has none", async () => {
    const path = await initRepo("noreadme", { "a.ts": "export const a = 1;\n" });
    await commitAll(path);

    const { data } = await loadLocalRepository("noreadme");

    expect(data.readme).toBe("");
  });

  it("finds a readme regardless of case or extension", async () => {
    const path = await initRepo("cased", {
      "readme": "plain readme\n",
      "a.ts": "export const a = 1;\n",
    });
    await commitAll(path);

    const { data } = await loadLocalRepository("cased");

    expect(data.readme).toContain("plain readme");
  });

  it("rejects a repository with no commits", async () => {
    await initRepo("empty", { "a.ts": "export const a = 1;\n" });

    await expect(loadLocalRepository("empty")).rejects.toThrow(
      LOCAL_REPO_NO_COMMITS_ERROR,
    );
  });

  it("rejects a repository whose files are all excluded", async () => {
    const path = await initRepo("allexcluded", {
      "node_modules/dep/index.js": "module.exports = 1;\n",
    });
    await commitAll(path);

    await expect(loadLocalRepository("allexcluded")).rejects.toThrow(
      LOCAL_REPO_EMPTY_ERROR,
    );
  });

  it("rejects loading when local repo mode is disabled, even for a valid repository", async () => {
    const path = await initRepo("gated", { "a.ts": "export const a = 1;\n" });
    await commitAll(path);
    vi.stubEnv("NODE_ENV", "production");

    await expect(loadLocalRepository("gated")).rejects.toThrow(
      LOCAL_REPO_NOT_FOUND_ERROR,
    );
  });

  // Deliberately built from a few long paths rather than many short ones: the
  // limit counts characters, so deep directory names reach 780k with ~1300
  // files instead of ~8000, which keeps this the only slow case in the file.
  it(
    "rejects a tree over the character limit",
    async () => {
      const deep = ["a".repeat(200), "b".repeat(200), "c".repeat(200)].join(
        "/",
      );
      const files: Record<string, string> = {};
      const perPath = deep.length + "/file0000.ts".length;
      const needed = Math.ceil(MAX_INCLUDED_FILE_TREE_CHARACTERS / perPath) + 5;
      for (let index = 0; index < needed; index++) {
        files[`${deep}/file${String(index).padStart(4, "0")}.ts`] = "0\n";
      }
      const path = await initRepo("huge", files);
      await commitAll(path);

      await expect(loadLocalRepository("huge")).rejects.toThrow(
        REPOSITORY_TOO_LARGE_ERROR,
      );
    },
    120_000,
  );
});
