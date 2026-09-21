import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  INVALID_LOCAL_REPO_NAME_ERROR,
  LOCAL_REPO_NOT_FOUND_ERROR,
  LOCAL_REPO_NOT_GIT_ERROR,
  LOCAL_REPO_OWNER,
  isLocalRepoEnabled,
  resolveLocalRepoPath,
} from "~/server/generate/local-repo";

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
