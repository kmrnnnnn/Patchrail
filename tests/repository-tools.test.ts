import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RepositoryWorkspace, discoverVerificationCommands } from "@/ai/repository";

const roots: string[] = [];

async function workspace() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "patchrail-test-"));
  roots.push(root);
  await fs.mkdir(path.join(root, "src"));
  await fs.writeFile(path.join(root, "src", "api.ts"), "fetch('https://api.example.com/v1')\n");
  return {
    root,
    repository: new RepositoryWorkspace(root, {
      maxReads: 30,
      maxFilesWritten: 5,
      maxContextBytes: 100_000,
    }),
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("bounded repository tools", () => {
  it("rejects path traversal", async () => {
    const { repository } = await workspace();
    await expect(repository.readFile("../secret.txt")).rejects.toThrow("Invalid repository path");
  });

  it("blocks credential files", async () => {
    const { root, repository } = await workspace();
    await fs.writeFile(path.join(root, ".env"), "TOKEN=secret");
    await expect(repository.readFile(".env")).rejects.toThrow();
    await expect(
      repository.applyPatch({
        path: ".pnpmfile.mjs",
        operation: "CREATE",
        content: "export default {};\n",
        expectedSha256: null,
      }),
    ).rejects.toThrow("Sensitive credential files");

    await fs.writeFile(path.join(root, ".corepack.env"), "COREPACK_HOME=/tmp/untrusted\n");
    expect((await repository.listTree("", 1)).some((entry) => entry.path === ".corepack.env")).toBe(
      false,
    );
  });

  it("does not follow a repository symlink to files outside the checkout", async () => {
    const { root, repository } = await workspace();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "patchrail-outside-"));
    roots.push(outside);
    await fs.writeFile(path.join(outside, "leak.txt"), "outside repository");
    await fs.symlink(
      outside,
      path.join(root, "linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(repository.readFile("linked/leak.txt")).rejects.toThrow(
      "Symbolic links are not allowed",
    );
    expect(
      (await repository.listTree("", 4)).some((entry) => entry.path.startsWith("linked")),
    ).toBe(false);
  });

  it("requires optimistic digests before updates", async () => {
    const { repository } = await workspace();
    await expect(
      repository.applyPatch({
        path: "src/api.ts",
        operation: "UPDATE",
        content: "fetch('https://api.example.com/v2')\n",
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow("File changed since it was read");
  });

  it("records a bounded changed payload after a valid edit", async () => {
    const { repository } = await workspace();
    const file = await repository.readFile("src/api.ts");
    await repository.applyPatch({
      path: "src/api.ts",
      operation: "UPDATE",
      content: "fetch('https://api.example.com/v2')\n",
      expectedSha256: file.sha256,
    });
    const [change] = await repository.getChangedPayload();
    expect(change).toMatchObject({ path: "src/api.ts", operation: "UPDATE" });
    expect(Buffer.from(change!.contentBase64!, "base64").toString()).toContain("/v2");
  });

  it("never writes a redacted credential placeholder back into source", async () => {
    const { root, repository } = await workspace();
    const sourcePath = path.join(root, "src", "bad-secret.ts");
    await fs.writeFile(
      sourcePath,
      'export const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";\n',
    );
    const file = await repository.readFile("src/bad-secret.ts");
    expect(file.content).not.toContain("ghp_");

    await expect(
      repository.applyPatch({
        path: "src/bad-secret.ts",
        operation: "UPDATE",
        content: `${file.content}\nexport const version = 2;\n`,
        expectedSha256: file.sha256,
      }),
    ).rejects.toThrow("redacted credentials");
    expect(await fs.readFile(sourcePath, "utf8")).toContain("ghp_");
  });

  it("rejects workflow writes under minimum GitHub permissions", async () => {
    const { repository } = await workspace();
    await expect(
      repository.applyPatch({
        path: ".github/workflows/ci.yml",
        operation: "CREATE",
        content: "name: CI",
        expectedSha256: null,
      }),
    ).rejects.toThrow("Workflow files cannot be changed");
  });

  it("discovers only Node scripts that actually exist", async () => {
    const { root } = await workspace();
    await fs.writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest", build: "next build" } }),
    );
    const commands = await discoverVerificationCommands(root);
    expect(commands.commands).toEqual(["npm run test", "npm run build"]);
    expect(commands.commands).not.toContain("npm run typecheck");
  });

  it("requires exact pnpm and Yarn versions and selects version-compatible installs", async () => {
    const pnpm = await workspace();
    await fs.writeFile(
      path.join(pnpm.root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.17.0", scripts: { test: "vitest" } }),
    );
    await fs.writeFile(path.join(pnpm.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await expect(discoverVerificationCommands(pnpm.root)).resolves.toMatchObject({
      installCommand: "pnpm install --frozen-lockfile",
      commands: ["pnpm run test"],
    });

    const classic = await workspace();
    await fs.writeFile(
      path.join(classic.root, "package.json"),
      JSON.stringify({ packageManager: "yarn@1.22.22", scripts: { test: "jest" } }),
    );
    await fs.writeFile(path.join(classic.root, "yarn.lock"), "# yarn lockfile v1\n");
    await expect(discoverVerificationCommands(classic.root)).resolves.toMatchObject({
      installCommand: "yarn install --frozen-lockfile",
      commands: ["yarn run test"],
    });

    const berry = await workspace();
    await fs.writeFile(
      path.join(berry.root, "package.json"),
      JSON.stringify({ packageManager: "yarn@4.18.0", scripts: { build: "next build" } }),
    );
    await fs.writeFile(path.join(berry.root, "yarn.lock"), "__metadata:\n  version: 8\n");
    await expect(discoverVerificationCommands(berry.root)).resolves.toMatchObject({
      installCommand: "yarn install --immutable",
      commands: ["yarn run build"],
    });
  });

  it("fails closed for unpinned or conflicting package-manager selections", async () => {
    const unpinned = await workspace();
    await fs.writeFile(
      path.join(unpinned.root, "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }),
    );
    await fs.writeFile(path.join(unpinned.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await expect(discoverVerificationCommands(unpinned.root)).rejects.toThrow("exact pnpm version");

    const conflicting = await workspace();
    await fs.writeFile(
      path.join(conflicting.root, "package.json"),
      JSON.stringify({ packageManager: "pnpm@11.17.0", scripts: { test: "vitest" } }),
    );
    await fs.writeFile(path.join(conflicting.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
    await fs.writeFile(path.join(conflicting.root, "yarn.lock"), "# yarn lockfile v1\n");
    await expect(discoverVerificationCommands(conflicting.root)).rejects.toThrow(
      "conflicting pnpm and Yarn lockfiles",
    );
  });

  it("prepares Rust and Go dependencies but omits unsafe pyproject-only verification", async () => {
    const rust = await workspace();
    await fs.writeFile(
      path.join(rust.root, "Cargo.toml"),
      "[package]\nname='fixture'\nversion='0.1.0'\n",
    );
    await fs.writeFile(path.join(rust.root, "Cargo.lock"), "# lock\n");
    await expect(discoverVerificationCommands(rust.root)).resolves.toMatchObject({
      ecosystem: "rust",
      installCommand: "cargo fetch --locked",
    });

    const go = await workspace();
    await fs.writeFile(path.join(go.root, "go.mod"), "module example.test/fixture\n\ngo 1.25\n");
    await expect(discoverVerificationCommands(go.root)).resolves.toMatchObject({
      ecosystem: "go",
      installCommand: "go mod download all",
    });

    const python = await workspace();
    await fs.writeFile(
      path.join(python.root, "pyproject.toml"),
      "[tool.pytest.ini_options]\ntestpaths=['tests']\n",
    );
    await expect(discoverVerificationCommands(python.root)).resolves.toMatchObject({
      ecosystem: "python",
      installCommand: null,
      commands: [],
    });
  });

  it("keeps the cheap initial map bounded for large trees and manifests", async () => {
    const { root } = await workspace();
    const dependencies = Object.fromEntries(
      Array.from({ length: 2_000 }, (_, index) => [`dependency-${index}`, "1.0.0"]),
    );
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ dependencies }));
    const many = path.join(root, "z-many");
    await fs.mkdir(many);
    await Promise.all(
      Array.from({ length: 1_500 }, (_, index) =>
        fs.writeFile(path.join(many, `file-${index}.ts`), "export {};\n"),
      ),
    );
    const repository = new RepositoryWorkspace(root, {
      maxReads: 30,
      maxFilesWritten: 5,
      maxContextBytes: 200_000,
    });

    const map = await repository.createInitialMap();
    expect(Buffer.byteLength(JSON.stringify(map))).toBeLessThan(150_000);
    expect(map.treeTruncated).toBe(true);
    expect(JSON.stringify(map.manifests)).toContain("truncated");
  });
});
