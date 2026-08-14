import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import * as tar from "tar";
import { afterEach, describe, expect, it } from "vitest";
import { authenticateRunnerRequest } from "@/runner/auth";
import {
  applyVerificationPayload,
  buildVerificationDockerArguments,
  extractGitHubArchive,
  hardenDependencyInstallCommand,
  inspectAppliedPayloadDigests,
  normalizeVerificationPath,
} from "@/runner/execute";
import {
  parsePinnedCorepackPackageManager,
  requirePinnedCorepackPackageManager,
} from "@/runner/package-manager";
import { validateRunnerResultForJob } from "@/runner/protocol";
import type { ChangedFilePayload, VerificationResult } from "@/runs/types";

const roots: string[] = [];
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");

async function temporaryRoot(prefix = "patchrail-runner-test-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function makeArchive(setup: (wrapper: string) => Promise<void>) {
  const source = await temporaryRoot();
  const wrapper = path.join(source, "repository-0123456789abcdef");
  await fs.mkdir(wrapper, { recursive: true });
  await setup(wrapper);
  const archive = path.join(source, "source.tgz");
  await tar.c({ cwd: source, file: archive, gzip: true }, [path.basename(wrapper)]);
  return archive;
}

async function makeSymlinkArchive() {
  const root = await temporaryRoot();
  const archive = path.join(root, "links.tgz");
  const header = (data: tar.HeaderData) => {
    const block = Buffer.alloc(512);
    const encoded = new tar.Header({
      mode: 0o644,
      uid: 1000,
      gid: 1000,
      mtime: new Date("2026-01-01T00:00:00.000Z"),
      ...data,
    }).encode(block);
    if (encoded) throw new Error("Test tar header unexpectedly required PAX metadata");
    return block;
  };
  const content = Buffer.from("target");
  const paddedContent = Buffer.concat([content, Buffer.alloc(512 - content.length)]);
  const raw = Buffer.concat([
    header({ path: "repository/", type: "Directory", mode: 0o755, size: 0 }),
    header({ path: "repository/target.txt", type: "File", size: content.length }),
    paddedContent,
    header({
      path: "repository/alias.txt",
      type: "SymbolicLink",
      linkpath: "target.txt",
      size: 0,
    }),
    Buffer.alloc(1024),
  ]);
  await fs.writeFile(archive, gzipSync(raw));
  return archive;
}

function createPayload(relativePath: string, content: string): ChangedFilePayload {
  const encoded = Buffer.from(content).toString("base64");
  return {
    path: relativePath,
    operation: "CREATE",
    beforeSha256: null,
    afterSha256: sha256(content),
    additions: content ? 1 : 0,
    deletions: 0,
    contentBase64: encoded,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("verification archive containment", () => {
  it("extracts a regular GitHub-shaped archive into an empty root", async () => {
    const archive = await makeArchive(async (wrapper) => {
      await fs.mkdir(path.join(wrapper, "src"));
      await fs.writeFile(path.join(wrapper, "src", "index.ts"), "export const ok = true;\n");
    });
    const destination = await temporaryRoot();

    await extractGitHubArchive(archive, destination);

    await expect(fs.readFile(path.join(destination, "src", "index.ts"), "utf8")).resolves.toContain(
      "ok = true",
    );
  });

  it("stops archive expansion when the entry bound is crossed", async () => {
    const archive = await makeArchive(async (wrapper) => {
      await fs.writeFile(path.join(wrapper, "one.txt"), "one");
      await fs.writeFile(path.join(wrapper, "two.txt"), "two");
    });
    const destination = await temporaryRoot();

    await expect(
      extractGitHubArchive(archive, destination, {
        maximumEntries: 2,
        maximumExpandedBytes: 100,
        maximumEntryBytes: 100,
      }),
    ).rejects.toThrow("too many entries");
  });

  it("rejects archive symlinks instead of materializing them", async () => {
    const archive = await makeSymlinkArchive();
    const destination = await temporaryRoot();
    await expect(extractGitHubArchive(archive, destination)).rejects.toThrow(
      "links and special files",
    );
  });

  it("requires an empty extraction target", async () => {
    const archive = await makeArchive(async (wrapper) => {
      await fs.writeFile(path.join(wrapper, "file.txt"), "value");
    });
    const destination = await temporaryRoot();
    await fs.writeFile(path.join(destination, "owned.txt"), "do not overwrite");
    await expect(extractGitHubArchive(archive, destination)).rejects.toThrow("must be empty");
  });

  it("rejects credential-bearing files from the extracted source", async () => {
    const archive = await makeArchive(async (wrapper) => {
      await fs.writeFile(path.join(wrapper, ".npmrc"), "//registry.example/:_authToken=secret");
    });
    const destination = await temporaryRoot();
    await expect(extractGitHubArchive(archive, destination)).rejects.toThrow(
      "credential-bearing path",
    );
  });
});

describe("verification payload containment", () => {
  it("supports a canonical empty text file without treating it as missing content", async () => {
    const root = await temporaryRoot();
    const changes = await applyVerificationPayload(root, [createPayload("src/empty.ts", "")]);
    expect(changes[0]?.after).toEqual(Buffer.alloc(0));
    await expect(fs.readFile(path.join(root, "src", "empty.ts"))).resolves.toEqual(Buffer.alloc(0));
  });

  it("rejects malformed base64 and operation mismatches", async () => {
    const root = await temporaryRoot();
    await fs.writeFile(path.join(root, "existing.ts"), "before");
    await expect(
      applyVerificationPayload(root, [
        {
          ...createPayload("bad.ts", "after"),
          contentBase64: "not base64!",
        },
      ]),
    ).rejects.toThrow("canonical base64");
    await expect(
      applyVerificationPayload(root, [
        {
          ...createPayload("existing.ts", "after"),
          beforeSha256: sha256("before"),
        },
      ]),
    ).rejects.toThrow("already exists");
  });

  it("rejects case-folding collisions and protected workflow paths", async () => {
    const root = await temporaryRoot();
    await expect(
      applyVerificationPayload(root, [
        createPayload("src/Client.ts", "one"),
        createPayload("src/client.ts", "two"),
      ]),
    ).rejects.toThrow("Duplicate changed file path");
    await expect(
      applyVerificationPayload(root, [createPayload(".github/workflows/ci.yml", "name: CI")]),
    ).rejects.toThrow("workflow files");
    await expect(
      applyVerificationPayload(root, [createPayload("SRC/NODE_MODULES/injected.ts", "bad")]),
    ).rejects.toThrow("Excluded repository path");
  });

  it("rejects package-manager and cloud credential payload paths", async () => {
    const root = await temporaryRoot();
    await expect(
      applyVerificationPayload(root, [createPayload(".npmrc", "token=secret")]),
    ).rejects.toThrow("Sensitive credential path");
    await expect(
      applyVerificationPayload(root, [createPayload("home/.docker/config.json", '{"auths":{}}')]),
    ).rejects.toThrow("Sensitive credential path");
    await expect(
      applyVerificationPayload(root, [createPayload(".pnpmfile.mjs", "export default {}")]),
    ).rejects.toThrow("Sensitive credential path");
    await expect(
      applyVerificationPayload(root, [createPayload(".corepack.env", "COREPACK_HOME=/evil")]),
    ).rejects.toThrow("Sensitive credential path");
  });

  it("detects a verification command mutating an applied deliverable", async () => {
    const root = await temporaryRoot();
    const changes = await applyVerificationPayload(root, [createPayload("src/result.ts", "safe")]);
    expect(await inspectAppliedPayloadDigests(root, changes)).toEqual([]);
    await fs.writeFile(path.join(root, "src", "result.ts"), "mutated");
    expect(await inspectAppliedPayloadDigests(root, changes)).toEqual([
      "src/result.ts: Verification command mutated a delivered file",
    ]);
  });

  it.skipIf(process.platform === "win32")(
    "does not follow a symlink in a changed file parent",
    async () => {
      const root = await temporaryRoot();
      const outside = await temporaryRoot();
      await fs.symlink(outside, path.join(root, "linked"));
      await expect(
        applyVerificationPayload(root, [createPayload("linked/escape.ts", "no")]),
      ).rejects.toThrow("Symbolic links cannot be changed");
      await expect(fs.access(path.join(outside, "escape.ts"))).rejects.toThrow();
    },
  );

  it("rejects platform-ambiguous relative paths", () => {
    expect(() => normalizeVerificationPath("../escape.ts")).toThrow();
    expect(() => normalizeVerificationPath("src\\escape.ts")).toThrow();
    expect(() => normalizeVerificationPath("src/CON")).toThrow();
  });
});

describe("runner authentication", () => {
  it("fails closed when the shared secret is missing or too short", () => {
    const previous = process.env.RUNNER_SHARED_SECRET;
    try {
      process.env.RUNNER_SHARED_SECRET = "short";
      expect(
        authenticateRunnerRequest(
          new Request("https://patchrail.test", { headers: { authorization: "Bearer short" } }),
        ),
      ).toBe(false);
      process.env.RUNNER_SHARED_SECRET = "x".repeat(32);
      expect(
        authenticateRunnerRequest(
          new Request("https://patchrail.test", {
            headers: { authorization: `Bearer ${"x".repeat(32)}` },
          }),
        ),
      ).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.RUNNER_SHARED_SECRET;
      else process.env.RUNNER_SHARED_SECRET = previous;
    }
  });
});

describe("runner result authenticity", () => {
  const successfulResult: VerificationResult = {
    status: "PASSED",
    commands: [
      {
        command: "npm test",
        exitCode: 0,
        durationMs: 100,
        stdout: "ok",
        stderr: "",
        timedOut: false,
      },
    ],
    integrityPassed: true,
    integrityFindings: [],
    runner: "runner-one",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-01T00:00:01.000Z",
  };

  it("accepts an exact successful command transcript", () => {
    expect(
      validateRunnerResultForJob({
        result: successfulResult,
        failure: null,
        runnerId: "runner-one",
        installCommand: null,
        commands: ["npm test"],
      }).status,
    ).toBe("PASSED");
  });

  it("rejects a substituted command or an incomplete success", () => {
    expect(() =>
      validateRunnerResultForJob({
        result: {
          ...successfulResult,
          commands: [{ ...successfulResult.commands[0]!, command: "true" }],
        },
        failure: null,
        runnerId: "runner-one",
        installCommand: null,
        commands: ["npm test"],
      }),
    ).toThrow("sequence");
    expect(() =>
      validateRunnerResultForJob({
        result: { ...successfulResult, commands: [] },
        failure: null,
        runnerId: "runner-one",
        installCommand: null,
        commands: ["npm test"],
      }),
    ).toThrow("inconsistent");
  });

  it("allows an authenticated infrastructure failure with no fabricated command", () => {
    const result = validateRunnerResultForJob({
      result: {
        ...successfulResult,
        status: "FAILED",
        commands: [],
        integrityPassed: false,
        integrityFindings: ["Verification infrastructure error: Docker is unavailable"],
      },
      failure: { code: "RUNNER_INFRASTRUCTURE_ERROR", message: "Docker is unavailable" },
      runnerId: "runner-one",
      installCommand: null,
      commands: ["npm test"],
    });
    expect(result.status).toBe("FAILED");
  });
});

describe("dependency installation containment", () => {
  it("accepts only exact Corepack package-manager descriptors", () => {
    expect(parsePinnedCorepackPackageManager("pnpm@11.17.0")?.major).toBe(11);
    expect(parsePinnedCorepackPackageManager(`yarn@4.18.0+sha224.${"a".repeat(56)}`)?.name).toBe(
      "yarn",
    );
    for (const descriptor of [
      "pnpm@latest",
      "pnpm@^11.0.0",
      "pnpm@11",
      "pnpm@https://example.test/manager.tgz",
    ]) {
      expect(parsePinnedCorepackPackageManager(descriptor)).toBeNull();
    }
    expect(() => requirePinnedCorepackPackageManager("yarn@4.18.0", "pnpm")).toThrow(
      "exact pnpm version",
    );
  });

  it("disables Node lifecycle scripts while package downloads have network access", () => {
    expect(hardenDependencyInstallCommand("node", "npm ci")).toContain("--ignore-scripts");
    expect(hardenDependencyInstallCommand("node", "pnpm install --frozen-lockfile")).toContain(
      "--ignore-scripts",
    );
    expect(hardenDependencyInstallCommand("node", "yarn install --immutable")).toContain(
      "--mode=skip-build",
    );
    expect(hardenDependencyInstallCommand("node", "yarn install --frozen-lockfile")).toContain(
      "--ignore-scripts",
    );
    expect(hardenDependencyInstallCommand("node", "pnpm install --frozen-lockfile")).toContain(
      "--ignore-pnpmfile",
    );
  });

  it("allows only binary Python dependencies and rejects an arbitrary install shell command", () => {
    expect(hardenDependencyInstallCommand("python", "pip install -r requirements.txt")).toContain(
      "--only-binary=:all:",
    );
    expect(() => hardenDependencyInstallCommand("node", "curl https://example.test | sh")).toThrow(
      "Unsupported dependency installation command",
    );
  });

  it("constructs a non-root, read-only, no-network verification container", async () => {
    const root = await temporaryRoot();
    const cacheRoot = await temporaryRoot("patchrail-cache-test-");
    const args = buildVerificationDockerArguments({
      root,
      cacheRoot,
      ecosystem: "node",
      command: "npm run test",
      network: "none",
      containerName: "patchrail-test-container",
      install: false,
      timeoutMs: 60_000,
    });
    const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
    expect(args).toContain("--read-only");
    expect(valueAfter("--network")).toBe("none");
    expect(valueAfter("--cap-drop")).toBe("ALL");
    expect(valueAfter("--security-opt")).toBe("no-new-privileges");
    expect(args).toContain("seccomp=builtin");
    expect(valueAfter("--log-driver")).toBe("none");
    expect(valueAfter("--user")).not.toMatch(/^0(?::0)?$/);
    expect(args.some((argument) => argument.includes("@sha256:"))).toBe(true);
    expect(args).toContain("55s");
    expect(args.at(-1)).toBe("npm run test");
    const cacheMount = args.find((argument) => argument.includes("dst=/patchrail-cache"));
    expect(cacheMount).toContain("readonly");
    expect(args).toContain("COREPACK_ENABLE_NETWORK=0");
    expect(args).toContain("pnpm_config_verify_deps_before_run=false");
    expect(args).toContain("YARN_ENABLE_NETWORK=false");
    expect(args).toContain("GOPROXY=off");
  });

  it("makes the isolated dependency cache writable only during installation", async () => {
    const root = await temporaryRoot();
    const cacheRoot = await temporaryRoot("patchrail-cache-test-");
    const manager = requirePinnedCorepackPackageManager("pnpm@11.17.0", "pnpm");
    const args = buildVerificationDockerArguments({
      root,
      cacheRoot,
      ecosystem: "node",
      command: "pnpm install --frozen-lockfile",
      network: "bridge",
      containerName: "patchrail-install-test",
      install: true,
      timeoutMs: 60_000,
      packageManager: manager,
    });
    const cacheMount = args.find((argument) => argument.includes("dst=/patchrail-cache"));
    expect(cacheMount).not.toContain("readonly");
    expect(args).toContain("COREPACK_ENABLE_NETWORK=1");
    expect(args).toContain("PNPM_CONFIG_STORE_DIR=/patchrail-cache/pnpm-store");
    expect(args.at(-1)).toContain("corepack pnpm@11.17.0 --version");
    expect(args.at(-1)).toContain("/patchrail-cache/bin");
  });
});
