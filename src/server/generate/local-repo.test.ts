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
  LOCAL_REPO_READ_FAILED_ERROR,
  createLocalSourceReader,
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
  // Local mode also requires storage to be pointed at a local S3-compatible
  // server (see isLocalRepoEnabled's doc comment), so every test that expects
  // local mode to be reachable needs this stubbed too.
  vi.stubEnv("R2_ENDPOINT", "http://127.0.0.1:9000");
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
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", path, ...args]);
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
  const git = (...args: string[]) =>
    execFileAsync("git", ["-C", path, ...args]);
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

  it("is false without R2_ENDPOINT, even with a root set", () => {
    vi.stubEnv("R2_ENDPOINT", undefined);
    expect(isLocalRepoEnabled()).toBe(false);
  });

  it("is false when R2_ENDPOINT is blank", () => {
    vi.stubEnv("R2_ENDPOINT", "   ");
    expect(isLocalRepoEnabled()).toBe(false);
  });

  it("is true with all three conditions satisfied", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("LOCAL_REPO_ROOT", root);
    vi.stubEnv("R2_ENDPOINT", "http://127.0.0.1:9000");
    expect(isLocalRepoEnabled()).toBe(true);
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
    // "src" itself is included as a directory entry, matching the GitHub
    // provider's tree builder, which the local provider must not differ from.
    expect(data.fileTree.split("\n").sort()).toEqual([
      "README.md",
      "src",
      "src/index.ts",
      "src/util.ts",
    ]);
    expect(data.pathTypes.get("src")).toBe("tree");
    expect(data.pathTypes.get("src/index.ts")).toBe("blob");
    expect(data.sourceBlobs?.get("src/index.ts")?.sha).toMatch(
      /^[a-f0-9]{40}$/,
    );
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

    // "dist" survives as a bare directory entry: shouldIncludeFile excludes
    // the minified blob inside it by suffix, but "dist" itself matches no
    // excluded directory segment, exactly as the GitHub provider would treat
    // the same tree. "node_modules" and everything under it are excluded.
    expect(data.fileTree.split("\n").sort()).toEqual([
      "dist",
      "src",
      "src/index.ts",
    ]);
  });

  it("returns an empty readme when the repository has none", async () => {
    const path = await initRepo("noreadme", {
      "a.ts": "export const a = 1;\n",
    });
    await commitAll(path);

    const { data } = await loadLocalRepository("noreadme");

    expect(data.readme).toBe("");
  });

  it("finds a readme regardless of case or extension", async () => {
    const path = await initRepo("cased", {
      readme: "plain readme\n",
      "a.ts": "export const a = 1;\n",
    });
    await commitAll(path);

    const { data } = await loadLocalRepository("cased");

    expect(data.readme).toContain("plain readme");
  });

  it("rejects a repository with no commits, and logs the real git failure", async () => {
    await initRepo("empty", { "a.ts": "export const a = 1;\n" });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(loadLocalRepository("empty")).rejects.toThrow(
      LOCAL_REPO_NO_COMMITS_ERROR,
    );

    // git ran and exited non-zero here, so the real stderr (which nothing
    // else surfaces) must reach the server log even though the thrown
    // message stays generic.
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      event: string;
      subcommand: string;
      exit_code: number | null;
      stderr: string;
    };
    expect(logged.event).toBe("generate.local_repo.git_failed");
    expect(logged.subcommand).toBe("rev-parse");
    expect(typeof logged.exit_code).toBe("number");
    expect(logged.stderr.length).toBeGreaterThan(0);

    errorSpy.mockRestore();
  });

  it("reports a read failure, not no-commits, when git cannot be spawned", async () => {
    const path = await initRepo("spawnfail", {
      "a.ts": "export const a = 1;\n",
    });
    await commitAll(path);

    // An empty PATH means the "git" executable cannot be found at all: the
    // process never starts, so this must not be reported as the repository
    // having no commits.
    const emptyPathDir = await mkdtemp(
      join(tmpdir(), "gitdiagram-empty-path-"),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.stubEnv("PATH", emptyPathDir);

    await expect(loadLocalRepository("spawnfail")).rejects.toThrow(
      LOCAL_REPO_READ_FAILED_ERROR,
    );

    expect(errorSpy).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(errorSpy.mock.calls[0]?.[0] as string) as {
      event: string;
      exit_code: number | string | null;
    };
    expect(logged.event).toBe("generate.local_repo.git_failed");
    expect(typeof logged.exit_code).not.toBe("number");

    errorSpy.mockRestore();
    await rm(emptyPathDir, { recursive: true, force: true });
  }, 15_000);

  it("rejects loading when R2_ENDPOINT is not configured, even for a valid repository", async () => {
    const path = await initRepo("no-r2", { "a.ts": "export const a = 1;\n" });
    await commitAll(path);
    vi.stubEnv("R2_ENDPOINT", undefined);

    await expect(loadLocalRepository("no-r2")).rejects.toThrow(
      LOCAL_REPO_NOT_FOUND_ERROR,
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
  it("rejects a tree over the character limit", async () => {
    const deep = ["a".repeat(200), "b".repeat(200), "c".repeat(200)].join("/");
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
  }, 120_000);
});

describe("createLocalSourceReader", () => {
  it("reads a file body by blob sha", async () => {
    const path = await initRepo("bodies", { "a.ts": "export const a = 1;\n" });
    await commitAll(path);
    const { repoPath, data } = await loadLocalRepository("bodies");
    const blob = data.sourceBlobs!.get("a.ts")!;

    const excerpt = await createLocalSourceReader(repoPath)({
      path: "a.ts",
      blob,
      signal: AbortSignal.timeout(5_000),
    });

    expect(excerpt).toEqual({
      path: "a.ts",
      text: "export const a = 1;\n",
      truncated: false,
    });
  });

  it("returns null for a blob larger than the byte cap", async () => {
    const path = await initRepo("big", { "a.ts": "x" });
    await commitAll(path);
    const { repoPath, data } = await loadLocalRepository("big");
    const blob = { ...data.sourceBlobs!.get("a.ts")!, size: 10_000_000 };

    await expect(
      createLocalSourceReader(repoPath)({
        path: "a.ts",
        blob,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBeNull();
  });

  it("returns null for binary content", async () => {
    const path = await initRepo("binary", {});
    await writeFile(join(path, "blob.bin"), Buffer.from([0x01, 0x00, 0x02]));
    await commitAll(path);
    const { repoPath, data } = await loadLocalRepository("binary");
    const blob = data.sourceBlobs!.get("blob.bin")!;

    await expect(
      createLocalSourceReader(repoPath)({
        path: "blob.bin",
        blob,
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBeNull();
  });

  it("returns null for a malformed sha without invoking git", async () => {
    // The repo path does not exist, so if the sha guard were missing this
    // would reach runGit and reject (a non-existent -C target is a git
    // failure), not resolve to null. Resolving to null proves git was never
    // invoked.
    await expect(
      createLocalSourceReader("/definitely/does/not/exist")({
        path: "a.ts",
        blob: { sha: "-rf", size: 1 },
        signal: AbortSignal.timeout(5_000),
      }),
    ).resolves.toBeNull();
  });
});
