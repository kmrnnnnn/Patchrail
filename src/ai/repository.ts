import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { createTwoFilesPatch } from "diff";
import type { ChangedFile, ChangedFilePayload } from "@/runs/types";
import { redactSecrets } from "@/security/redaction";
import {
  parsePinnedCorepackPackageManager,
  requirePinnedCorepackPackageManager,
} from "@/runner/package-manager";

const EXCLUDED_DIRECTORY_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".turbo",
  ".parcel-cache",
  "vendor",
  "target",
  "__pycache__",
  ".venv",
  "venv",
]);

const SENSITIVE_FILE_PATTERNS = [
  /^\.env(?:\..+)?$/i,
  /\.pem$/i,
  /\.p12$/i,
  /\.pfx$/i,
  /id_rsa/i,
  /^(?:\.npmrc|\.pypirc|\.netrc|pip\.conf)$/i,
  /^(?:settings\.xml|nuget\.config|auth\.json)$/i,
  /^\.?pnpmfile\.(?:cjs|mjs)$/i,
  /^\.corepack\.env$/i,
  /^\.yarnrc(?:\.yml)?$/i,
  /credentials?\.json$/i,
  /service[-_]?account.*\.json$/i,
];
const SENSITIVE_PATH_PATTERNS = [
  /(?:^|\/)\.aws\/(?:credentials|config)$/i,
  /(?:^|\/)\.docker\/config\.json$/i,
  /(?:^|\/)\.config\/containers\/auth\.json$/i,
  /(?:^|\/)\.config\/gcloud\/(?:application_default_credentials\.json|credentials\.db|access_tokens\.db)$/i,
  /(?:^|\/)\.azure\/(?:accesstokens\.json|azureprofile\.json|msal_token_cache\.json)$/i,
  /(?:^|\/)\.kube\/config$/i,
  /(?:^|\/)\.cargo\/credentials(?:\.toml)?$/i,
  /(?:^|\/)\.config\/gh\/hosts\.yml$/i,
  /(?:^|\/)\.yarn\/plugins(?:\/|$)/i,
  /(?:^|\/)\.gem\/credentials$/i,
  /(?:^|\/)\.bundle\/config$/i,
];

const TEXT_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".conf",
  ".cpp",
  ".cs",
  ".css",
  ".env.example",
  ".go",
  ".graphql",
  ".gql",
  ".h",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".md",
  ".mjs",
  ".php",
  ".prisma",
  ".properties",
  ".py",
  ".rb",
  ".rs",
  ".sh",
  ".sql",
  ".svelte",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".txt",
  ".vue",
  ".xml",
  ".yaml",
  ".yml",
]);

const MANIFEST_NAMES = new Set([
  "package.json",
  "pyproject.toml",
  "requirements.txt",
  "Pipfile",
  "poetry.lock",
  "go.mod",
  "Cargo.toml",
  "Gemfile",
  "composer.json",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

const MAX_TEXT_FILE_BYTES = 512_000;
const MAX_TREE_ENTRIES = 12_000;
const MAX_TREE_OUTPUT_BYTES = 80_000;
const MAX_SEARCH_RESULTS = 100;
const MAX_INITIAL_MANIFESTS = 20;
const MAX_INITIAL_MANIFEST_BYTES = 48_000;
const MAX_INITIAL_MANIFEST_BYTES_EACH = 12_000;
const MAX_INITIAL_URL_FILES = 200;
const MAX_INITIAL_URL_SCAN_BYTES = 1_000_000;

export type RepositoryFileEntry = {
  path: string;
  size: number;
  kind: "file" | "directory";
};

export type RepositoryChange = {
  path: string;
  operation: "CREATE" | "UPDATE" | "DELETE";
  before: Buffer | null;
  after: Buffer | null;
};

type RepositoryLimits = {
  maxReads: number;
  maxFilesWritten: number;
  maxContextBytes: number;
};

function digest(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function boundedUtf8(value: string, maxBytes: number): string {
  const buffer = Buffer.from(value, "utf8");
  if (buffer.length <= maxBytes) return value;
  return `${buffer.subarray(0, maxBytes).toString("utf8")}\n[truncated]`;
}

function isLikelyText(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8_000));
  return !sample.includes(0);
}

function normalizeRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
    throw new Error("A repository-relative path is required");
  }
  const parts = normalized.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error("Invalid repository path");
  }
  return parts.join("/");
}

function isSensitivePath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").toLowerCase();
  if (SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(normalized))) return true;
  const name = path.posix.basename(relativePath);
  if (name === ".env.example" || name.endsWith(".env.example")) return false;
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

function isExcludedPath(relativePath: string): boolean {
  const segments = relativePath.split("/");
  return segments.some((segment) => EXCLUDED_DIRECTORY_NAMES.has(segment.toLowerCase()));
}

function isTextPath(relativePath: string): boolean {
  const name = path.posix.basename(relativePath);
  if (MANIFEST_NAMES.has(name)) return true;
  const extension = path.posix.extname(name).toLowerCase();
  return TEXT_EXTENSIONS.has(extension) || name.startsWith("Dockerfile") || name === "Makefile";
}

export class RepositoryWorkspace {
  readonly root: string;
  private readonly originals = new Map<string, Buffer | null>();
  private readonly redactedPaths = new Set<string>();
  private readonly limits: RepositoryLimits;
  private readCount = 0;
  private contextBytes = 0;
  private lastTreeWasTruncated = false;

  constructor(root: string, limits: RepositoryLimits) {
    this.root = path.resolve(root);
    this.limits = limits;
  }

  get usage() {
    return {
      reads: this.readCount,
      contextBytes: this.contextBytes,
      filesWritten: this.originals.size,
    };
  }

  private resolve(relativePath: string, options?: { allowWorkflow?: boolean }): string {
    const safe = normalizeRelativePath(relativePath);
    if (isExcludedPath(safe)) throw new Error("This path is excluded by repository policy");
    if (isSensitivePath(safe))
      throw new Error("Sensitive credential files cannot be read or changed");
    if (!options?.allowWorkflow && safe.startsWith(".github/workflows/")) {
      throw new Error(
        "Workflow files cannot be changed with Patchrail's minimum GitHub permissions",
      );
    }
    const absolute = path.resolve(this.root, ...safe.split("/"));
    const prefix = `${this.root}${path.sep}`;
    if (absolute !== this.root && !absolute.startsWith(prefix))
      throw new Error("Path escaped repository");
    return absolute;
  }

  private consumeRead(bytes: number) {
    this.readCount += 1;
    this.contextBytes += bytes;
    if (this.readCount > this.limits.maxReads) throw new Error("Repository read limit reached");
    if (this.contextBytes > this.limits.maxContextBytes)
      throw new Error("Repository context limit reached");
  }

  private async assertNoSymlinkComponents(
    absolutePath: string,
    options: { allowMissing?: boolean } = {},
  ): Promise<void> {
    const relative = path.relative(this.root, absolutePath);
    if (relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("Path escaped repository");
    }
    let current = this.root;
    const parts = relative ? relative.split(path.sep) : [];
    for (const part of ["", ...parts]) {
      if (part) current = path.join(current, part);
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink())
          throw new Error("Symbolic links are not allowed in repository paths");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissing) return;
        throw error;
      }
    }
  }

  async listTree(relativePath = "", depth = 4): Promise<RepositoryFileEntry[]> {
    const start = relativePath ? this.resolve(relativePath, { allowWorkflow: true }) : this.root;
    const base = relativePath ? normalizeRelativePath(relativePath) : "";
    const output: RepositoryFileEntry[] = [];
    let outputBytes = 2;
    this.lastTreeWasTruncated = false;
    await this.assertNoSymlinkComponents(start);

    const addEntry = (entry: RepositoryFileEntry) => {
      const bytes = Buffer.byteLength(JSON.stringify(entry)) + 1;
      if (output.length >= MAX_TREE_ENTRIES || outputBytes + bytes > MAX_TREE_OUTPUT_BYTES) {
        this.lastTreeWasTruncated = true;
        return false;
      }
      output.push(entry);
      outputBytes += bytes;
      return true;
    };

    const walk = async (directory: string, relativeDirectory: string, remainingDepth: number) => {
      if (remainingDepth < 0 || this.lastTreeWasTruncated) return;
      const entries = await fs.readdir(directory, { withFileTypes: true });
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (this.lastTreeWasTruncated) break;
        const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (isExcludedPath(relative) || isSensitivePath(relative) || entry.isSymbolicLink())
          continue;
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!addEntry({ path: relative, size: 0, kind: "directory" })) break;
          await walk(absolute, relative, remainingDepth - 1);
        } else if (entry.isFile()) {
          const stat = await fs.stat(absolute);
          if (!addEntry({ path: relative, size: stat.size, kind: "file" })) break;
        }
      }
    };

    await walk(start, base, Math.min(Math.max(depth, 0), 8));
    this.consumeRead(Buffer.byteLength(JSON.stringify(output)));
    return output;
  }

  async readFile(relativePath: string): Promise<{ content: string; sha256: string; size: number }> {
    const safe = normalizeRelativePath(relativePath);
    if (!isTextPath(safe)) throw new Error("Only relevant text source files may be read");
    const absolute = this.resolve(safe, { allowWorkflow: true });
    await this.assertNoSymlinkComponents(absolute);
    const stat = await fs.stat(absolute);
    if (!stat.isFile()) throw new Error("Path is not a file");
    if (stat.size > MAX_TEXT_FILE_BYTES) throw new Error("File exceeds the per-file read limit");
    const buffer = await fs.readFile(absolute);
    if (!isLikelyText(buffer)) throw new Error("Binary files cannot be read");
    const rawContent = buffer.toString("utf8");
    const content = redactSecrets(rawContent);
    if (content !== rawContent) this.redactedPaths.add(safe);
    this.consumeRead(Buffer.byteLength(content));
    return { content, sha256: digest(buffer), size: buffer.length };
  }

  async readFileRange(relativePath: string, startLine: number, endLine: number) {
    if (startLine < 1 || endLine < startLine || endLine - startLine > 500) {
      throw new Error("Line range must contain 1 to 500 lines");
    }
    const file = await this.readFile(relativePath);
    const lines = file.content.split("\n");
    return {
      content: lines.slice(startLine - 1, endLine).join("\n"),
      startLine,
      endLine: Math.min(endLine, lines.length),
      totalLines: lines.length,
      sha256: file.sha256,
    };
  }

  async searchRepository(
    query: string,
    options: { path?: string; caseSensitive?: boolean } = {},
  ): Promise<Array<{ path: string; line: number; text: string }>> {
    if (!query || query.length > 200) throw new Error("Search query must be 1 to 200 characters");
    const tree = await this.listTree(options.path ?? "", 8);
    const needle = options.caseSensitive ? query : query.toLowerCase();
    const results: Array<{ path: string; line: number; text: string }> = [];

    for (const entry of tree) {
      if (results.length >= MAX_SEARCH_RESULTS || entry.kind !== "file") break;
      if (!isTextPath(entry.path) || entry.size > MAX_TEXT_FILE_BYTES) continue;
      try {
        const absolute = this.resolve(entry.path, { allowWorkflow: true });
        await this.assertNoSymlinkComponents(absolute);
        const buffer = await fs.readFile(absolute);
        if (!isLikelyText(buffer)) continue;
        const lines = redactSecrets(buffer.toString("utf8")).split("\n");
        for (let index = 0; index < lines.length; index += 1) {
          const line = lines[index] ?? "";
          const haystack = options.caseSensitive ? line : line.toLowerCase();
          if (haystack.includes(needle)) {
            results.push({ path: entry.path, line: index + 1, text: line.slice(0, 500) });
            if (results.length >= MAX_SEARCH_RESULTS) break;
          }
        }
      } catch {
        // A racing or unreadable file is simply omitted from bounded search results.
      }
    }
    const resultBytes = Buffer.byteLength(JSON.stringify(results));
    this.consumeRead(resultBytes);
    return results;
  }

  async readManifest(relativePath: string) {
    const safe = normalizeRelativePath(relativePath);
    if (!MANIFEST_NAMES.has(path.posix.basename(safe)))
      throw new Error("Path is not a recognized manifest");
    const file = await this.readFile(safe);
    if (path.posix.basename(safe) !== "package.json") return file;

    const parsed = JSON.parse(file.content) as Record<string, unknown>;
    return {
      sha256: file.sha256,
      name: parsed.name ?? null,
      packageManager: parsed.packageManager ?? null,
      scripts: parsed.scripts ?? {},
      dependencies: parsed.dependencies ?? {},
      devDependencies: parsed.devDependencies ?? {},
      peerDependencies: parsed.peerDependencies ?? {},
    };
  }

  async applyPatch(input: {
    path: string;
    operation: "CREATE" | "UPDATE" | "DELETE";
    content: string | null;
    expectedSha256: string | null;
  }): Promise<{ path: string; operation: string; sha256: string | null }> {
    const safe = normalizeRelativePath(input.path);
    if (!isTextPath(safe)) throw new Error("Only text source files can be modified");
    if (this.redactedPaths.has(safe)) {
      throw new Error("A file containing redacted credentials cannot be modified");
    }
    const absolute = this.resolve(safe);
    await this.assertNoSymlinkComponents(absolute, { allowMissing: true });
    let existing: Buffer | null = null;
    try {
      existing = await fs.readFile(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }

    if (!this.originals.has(safe)) {
      if (this.originals.size >= this.limits.maxFilesWritten)
        throw new Error("File write limit reached");
      this.originals.set(safe, existing);
    }

    if (input.operation === "CREATE" && existing) throw new Error("CREATE target already exists");
    if (input.operation !== "CREATE" && !existing) throw new Error("Target file does not exist");
    if (existing && input.expectedSha256 !== digest(existing)) {
      throw new Error("File changed since it was read; read it again before applying a patch");
    }

    if (input.operation === "DELETE") {
      if (input.content !== null) throw new Error("DELETE content must be null");
      await fs.unlink(absolute);
      return { path: safe, operation: input.operation, sha256: null };
    }

    if (input.content === null || Buffer.byteLength(input.content) > MAX_TEXT_FILE_BYTES) {
      throw new Error("Patch content is missing or too large");
    }
    await fs.mkdir(path.dirname(absolute), { recursive: true });
    await this.assertNoSymlinkComponents(path.dirname(absolute));
    await fs.writeFile(absolute, input.content, "utf8");
    return { path: safe, operation: input.operation, sha256: digest(input.content) };
  }

  async readDiff(): Promise<string> {
    const changes = await this.getChanges();
    const patches = changes.map((change) =>
      createTwoFilesPatch(
        `a/${change.path}`,
        `b/${change.path}`,
        change.before?.toString("utf8") ?? "",
        change.after?.toString("utf8") ?? "",
        "before",
        "after",
        { context: 3 },
      ),
    );
    const output = patches.join("\n").slice(0, 200_000);
    this.consumeRead(Buffer.byteLength(output));
    return output;
  }

  async getChanges(): Promise<RepositoryChange[]> {
    const changes: RepositoryChange[] = [];
    for (const [relativePath, before] of this.originals) {
      let after: Buffer | null = null;
      try {
        const absolute = this.resolve(relativePath);
        await this.assertNoSymlinkComponents(absolute, { allowMissing: true });
        after = await fs.readFile(absolute);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (before?.equals(after ?? Buffer.alloc(0))) continue;
      if (!before && !after) continue;
      changes.push({
        path: relativePath,
        operation: before ? (after ? "UPDATE" : "DELETE") : "CREATE",
        before,
        after,
      });
    }
    return changes.sort((a, b) => a.path.localeCompare(b.path));
  }

  async getChangedFiles(): Promise<ChangedFile[]> {
    return (await this.getChanges()).map((change) => {
      const beforeLines = change.before?.toString("utf8").split("\n") ?? [];
      const afterLines = change.after?.toString("utf8").split("\n") ?? [];
      return {
        path: change.path,
        operation: change.operation,
        beforeSha256: change.before ? digest(change.before) : null,
        afterSha256: change.after ? digest(change.after) : null,
        additions: Math.max(0, afterLines.length - beforeLines.length),
        deletions: Math.max(0, beforeLines.length - afterLines.length),
      };
    });
  }

  async getChangedPayload(): Promise<ChangedFilePayload[]> {
    const metadata = new Map((await this.getChangedFiles()).map((item) => [item.path, item]));
    return (await this.getChanges()).map((change) => ({
      ...metadata.get(change.path)!,
      contentBase64: change.after?.toString("base64") ?? null,
    }));
  }

  async createInitialMap(): Promise<RepositoryMap> {
    const tree = await this.listTree("", 6);
    const manifests: Array<{ path: string; summary: unknown }> = [];
    const configurationFiles: string[] = [];
    const urlObservations = new Set<string>();
    let manifestBytes = 0;
    let urlFilesScanned = 0;
    let urlBytesScanned = 0;

    for (const entry of tree) {
      if (entry.kind !== "file") continue;
      const name = path.posix.basename(entry.path);
      if (
        MANIFEST_NAMES.has(name) &&
        entry.size <= MAX_TEXT_FILE_BYTES &&
        manifests.length < MAX_INITIAL_MANIFESTS &&
        manifestBytes < MAX_INITIAL_MANIFEST_BYTES
      ) {
        try {
          const absolute = this.resolve(entry.path, { allowWorkflow: true });
          await this.assertNoSymlinkComponents(absolute);
          const raw = redactSecrets(await fs.readFile(absolute, "utf8"));
          let summary: unknown;
          if (name === "package.json") {
            const parsed = JSON.parse(raw) as Record<string, unknown>;
            summary = {
              name: parsed.name ?? null,
              packageManager: parsed.packageManager ?? null,
              scripts: parsed.scripts ?? {},
              dependencies: parsed.dependencies ?? {},
              devDependencies: parsed.devDependencies ?? {},
              peerDependencies: parsed.peerDependencies ?? {},
            };
          } else {
            summary = { preview: boundedUtf8(raw, MAX_INITIAL_MANIFEST_BYTES_EACH) };
          }
          const serialized = JSON.stringify(summary);
          const compactSummary =
            Buffer.byteLength(serialized) <= MAX_INITIAL_MANIFEST_BYTES_EACH
              ? summary
              : {
                  preview: boundedUtf8(serialized, MAX_INITIAL_MANIFEST_BYTES_EACH),
                  truncated: true,
                };
          const nextBytes = Buffer.byteLength(JSON.stringify(compactSummary));
          if (manifestBytes + nextBytes <= MAX_INITIAL_MANIFEST_BYTES) {
            manifests.push({ path: entry.path, summary: compactSummary });
            manifestBytes += nextBytes;
          }
        } catch {
          manifests.push({ path: entry.path, summary: "Manifest could not be parsed" });
        }
      }
      if (
        /^(?:Dockerfile|Makefile|tsconfig|vite|next|nuxt|webpack|eslint|prettier|biome|compose)/i.test(
          name,
        )
      ) {
        configurationFiles.push(entry.path);
      }
      if (
        entry.size <= 100_000 &&
        isTextPath(entry.path) &&
        urlObservations.size < 100 &&
        urlFilesScanned < MAX_INITIAL_URL_FILES &&
        urlBytesScanned + entry.size <= MAX_INITIAL_URL_SCAN_BYTES
      ) {
        try {
          const absolute = this.resolve(entry.path, { allowWorkflow: true });
          await this.assertNoSymlinkComponents(absolute);
          const content = await fs.readFile(absolute, "utf8");
          urlFilesScanned += 1;
          urlBytesScanned += entry.size;
          for (const match of content.matchAll(/https?:\/\/([a-z0-9.-]+)(?:[:/]|$)/gi)) {
            if (match[1] && !/^(?:localhost|127\.0\.0\.1)$/.test(match[1])) {
              urlObservations.add(match[1].toLowerCase());
            }
          }
        } catch {
          // Cheap URL hints are optional.
        }
      }
    }

    this.consumeRead(
      Buffer.byteLength(
        JSON.stringify({ manifests, configurationFiles, observedDomains: [...urlObservations] }),
      ),
    );

    return {
      tree,
      treeTruncated: this.lastTreeWasTruncated,
      manifests,
      configurationFiles: configurationFiles.slice(0, 200),
      observedDomains: [...urlObservations],
      policy: {
        excludedDirectories: [...EXCLUDED_DIRECTORY_NAMES],
        maxTextFileBytes: MAX_TEXT_FILE_BYTES,
        maxReads: this.limits.maxReads,
        maxFilesWritten: this.limits.maxFilesWritten,
        maxContextBytes: this.limits.maxContextBytes,
      },
    };
  }
}

export type RepositoryMap = {
  tree: RepositoryFileEntry[];
  treeTruncated: boolean;
  manifests: Array<{ path: string; summary: unknown }>;
  configurationFiles: string[];
  observedDomains: string[];
  policy: {
    excludedDirectories: string[];
    maxTextFileBytes: number;
    maxReads: number;
    maxFilesWritten: number;
    maxContextBytes: number;
  };
};

export async function discoverVerificationCommands(root: string): Promise<{
  ecosystem: string;
  installCommand: string | null;
  commands: string[];
}> {
  const exists = async (name: string) => {
    try {
      await fs.access(path.join(root, name));
      return true;
    } catch {
      return false;
    }
  };

  if (await exists("package.json")) {
    const manifest = JSON.parse(await fs.readFile(path.join(root, "package.json"), "utf8")) as {
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
      dependencies?: Record<string, string>;
      packageManager?: unknown;
    };
    const hasPnpmLock = await exists("pnpm-lock.yaml");
    const hasYarnLock = await exists("yarn.lock");
    if (hasPnpmLock && hasYarnLock) {
      throw new Error("Verification cannot choose between conflicting pnpm and Yarn lockfiles");
    }
    const manager = hasPnpmLock ? "pnpm" : hasYarnLock ? "yarn" : "npm";
    const pinnedManager =
      manager === "pnpm" || manager === "yarn"
        ? requirePinnedCorepackPackageManager(manifest.packageManager, manager)
        : parsePinnedCorepackPackageManager(manifest.packageManager);
    if (manager === "npm" && pinnedManager) {
      throw new Error(
        `package.json selects ${pinnedManager.name}, but its matching lockfile is missing`,
      );
    }
    const installCommand =
      manager === "pnpm"
        ? "pnpm install --frozen-lockfile"
        : manager === "yarn"
          ? pinnedManager!.major === 1
            ? "yarn install --frozen-lockfile"
            : "yarn install --immutable"
          : (await exists("package-lock.json"))
            ? "npm ci"
            : "npm install";
    const scripts = manifest.scripts ?? {};
    const commands = ["typecheck", "test", "build"]
      .filter((script) => Boolean(scripts[script]))
      .map((script) => `${manager} run ${script}`);
    return { ecosystem: "node", installCommand, commands };
  }

  if (await exists("Cargo.toml")) {
    return {
      ecosystem: "rust",
      installCommand: (await exists("Cargo.lock")) ? "cargo fetch --locked" : "cargo fetch",
      commands: ["cargo test"],
    };
  }
  if (await exists("go.mod")) {
    return {
      ecosystem: "go",
      installCommand: "go mod download all",
      commands: ["go test ./..."],
    };
  }
  if ((await exists("pyproject.toml")) || (await exists("requirements.txt"))) {
    const hasPytestConfig =
      (await exists("pytest.ini")) ||
      (await exists("conftest.py")) ||
      ((await exists("pyproject.toml")) &&
        (await fs.readFile(path.join(root, "pyproject.toml"), "utf8")).includes("pytest"));
    const hasRequirements = await exists("requirements.txt");
    return {
      ecosystem: "python",
      installCommand: hasRequirements ? "pip install -r requirements.txt" : null,
      // Installing an arbitrary pyproject build backend would execute repository code while
      // egress is enabled. Until a locked, binary-only flow is supported, do not claim that
      // pyproject-only repositories can be verified.
      commands: hasRequirements && hasPytestConfig ? ["python -m pytest"] : [],
    };
  }

  return { ecosystem: "unknown", installCommand: null, commands: [] };
}
