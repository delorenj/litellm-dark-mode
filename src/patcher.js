import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_VERSION = "0.2.1";
export const MANIFEST_NAME = ".litellm-dark-mode.json";

const MANIFEST_SCHEMA_VERSION = 1;
const DARK_CSS_RELATIVE_PATH = "src/app/litellm-dark-mode.css";
const SOURCE_PATHS = {
  globals: "src/app/globals.css",
  layout: "src/app/layout.tsx",
  antdProvider: "src/contexts/AntdGlobalProvider.tsx",
};
const MANAGED_IMPORT_COMMENT =
  "/* litellm-dark-mode: managed import; apparently photons needed a package manager. */";
const DARK_CSS_IMPORT = '@import "./litellm-dark-mode.css";';
const DARK_CSS_URL = new URL("../assets/litellm-dark-mode.css", import.meta.url);

export class LiteLLMDarkModeError extends Error {
  constructor(message, code = "PATCH_ERROR") {
    super(message);
    this.name = "LiteLLMDarkModeError";
    this.code = code;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function pathExists(candidate) {
  try {
    await access(candidate);
    return true;
  } catch {
    return false;
  }
}

async function looksLikeDashboard(candidate) {
  const required = [
    "package.json",
    SOURCE_PATHS.globals,
    SOURCE_PATHS.layout,
    SOURCE_PATHS.antdProvider,
  ];

  if (!(await Promise.all(required.map((relative) => pathExists(path.join(candidate, relative))))).every(Boolean)) {
    return false;
  }

  try {
    const packageJson = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
    return packageJson.name === "litellm-dashboard";
  } catch {
    return false;
  }
}

export async function resolveDashboardRoot(inputPath = ".") {
  const requested = path.resolve(inputPath);
  const candidates = [
    requested,
    path.join(requested, "ui", "litellm-dashboard"),
    path.join(requested, "litellm-dashboard"),
  ];

  for (const candidate of candidates) {
    if (await looksLikeDashboard(candidate)) {
      return realpath(candidate);
    }
  }

  throw new LiteLLMDarkModeError(
    [
      `Could not find the LiteLLM dashboard under ${requested}.`,
      "Pass either the LiteLLM repository root or ui/litellm-dashboard itself.",
    ].join(" "),
    "DASHBOARD_NOT_FOUND",
  );
}

function patchGlobals(source) {
  if (source.includes(DARK_CSS_IMPORT)) {
    if (source.includes(MANAGED_IMPORT_COMMENT)) return source;
    throw new LiteLLMDarkModeError(
      `${DARK_CSS_IMPORT} already exists but is not managed by this tool. Refusing to claim it.`,
      "GLOBALS_CONFLICT",
    );
  }

  const imports = [...source.matchAll(/^@import[^;\n]+;[ \t]*$/gm)];
  const lastImport = imports.at(-1);
  if (!lastImport || lastImport.index === undefined) {
    throw new LiteLLMDarkModeError(
      "globals.css has no recognizable @import block. LiteLLM probably moved the furniture again.",
      "UNSUPPORTED_GLOBALS",
    );
  }

  const insertionPoint = lastImport.index + lastImport[0].length;
  const addition = `\n${MANAGED_IMPORT_COMMENT}\n${DARK_CSS_IMPORT}`;
  return `${source.slice(0, insertionPoint)}${addition}${source.slice(insertionPoint)}`;
}

function patchHtmlTag(tag) {
  let patched = tag;
  const staticClassName = patched.match(/\bclassName\s*=\s*(["'])([^"']*)\1/);

  if (staticClassName) {
    const classes = staticClassName[2].split(/\s+/).filter(Boolean);
    if (!classes.includes("dark")) classes.push("dark");
    patched = patched.replace(staticClassName[0], `className=${staticClassName[1]}${classes.join(" ")}${staticClassName[1]}`);
  } else if (/\bclassName\s*=/.test(patched)) {
    throw new LiteLLMDarkModeError(
      "The root <html> uses a dynamic className that this patcher cannot safely rewrite.",
      "UNSUPPORTED_LAYOUT",
    );
  } else {
    patched = patched.replace(/>$/, ' className="dark">');
  }

  if (!/\bdata-litellm-dark-mode\s*=/.test(patched)) {
    patched = patched.replace(/>$/, ' data-litellm-dark-mode="forced">');
  }
  if (!/\bstyle\s*=/.test(patched)) {
    patched = patched.replace(/>$/, ' style={{ colorScheme: "dark" }}>');
  }

  return patched;
}

function patchLayout(source) {
  if (source.includes('data-litellm-dark-mode="forced"')) return source;

  const htmlTags = [...source.matchAll(/<html\b[^>]*>/g)];
  if (htmlTags.length !== 1 || htmlTags[0].index === undefined) {
    throw new LiteLLMDarkModeError(
      `Expected one root <html> tag in layout.tsx; found ${htmlTags.length}.`,
      "UNSUPPORTED_LAYOUT",
    );
  }

  const originalTag = htmlTags[0][0];
  const patchedTag = patchHtmlTag(originalTag);
  return `${source.slice(0, htmlTags[0].index)}${patchedTag}${source.slice(htmlTags[0].index + originalTag.length)}`;
}

function patchAntdImport(source) {
  const importPattern = /import\s*\{([^}]*)\}\s*from\s*(["'])antd\2;/g;
  const imports = [...source.matchAll(importPattern)];
  if (imports.length !== 1 || imports[0].index === undefined) {
    throw new LiteLLMDarkModeError(
      `Expected one named import from antd in AntdGlobalProvider.tsx; found ${imports.length}.`,
      "UNSUPPORTED_ANTD_PROVIDER",
    );
  }

  const match = imports[0];
  if (/\blitellmDarkModeAntdTheme\b/.test(match[1])) return source;

  const namesWithoutTrailingSpace = match[1].replace(/\s+$/, "");
  const trailingSpace = match[1].slice(namesWithoutTrailingSpace.length);
  const separator = namesWithoutTrailingSpace.trimEnd().endsWith(",") ? " " : ", ";
  const replacement = match[0].replace(
    match[1],
    `${namesWithoutTrailingSpace}${separator}theme as litellmDarkModeAntdTheme${trailingSpace}`,
  );

  return `${source.slice(0, match.index)}${replacement}${source.slice(match.index + match[0].length)}`;
}

function patchAntdProvider(source) {
  if (source.includes("litellmDarkModeAntdTheme.darkAlgorithm")) return source;
  if (/\balgorithm\s*:/.test(source)) {
    throw new LiteLLMDarkModeError(
      "AntdGlobalProvider already configures a theme algorithm. Native dark mode may have finally escaped review.",
      "ANTD_THEME_CONFLICT",
    );
  }

  const withImport = patchAntdImport(source);
  const configPattern = /theme=\{\{\s*cssVar\s*:\s*true\s*\}\}/g;
  const configs = [...withImport.matchAll(configPattern)];
  if (configs.length !== 1) {
    throw new LiteLLMDarkModeError(
      `Expected one simple Ant Design theme config; found ${configs.length}.`,
      "UNSUPPORTED_ANTD_PROVIDER",
    );
  }

  return withImport.replace(
    configPattern,
    "theme={{ cssVar: true, algorithm: litellmDarkModeAntdTheme.darkAlgorithm }}",
  );
}

async function readSourceFiles(dashboardRoot) {
  const entries = await Promise.all(
    Object.values(SOURCE_PATHS).map(async (relativePath) => [
      relativePath,
      await readFile(path.join(dashboardRoot, relativePath), "utf8"),
    ]),
  );
  return Object.fromEntries(entries);
}

async function getGitRevision(dashboardRoot) {
  try {
    const { stdout } = await execFileAsync("git", ["-C", dashboardRoot, "rev-parse", "--short=12", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function atomicWrite(filename, content, mode = 0o644) {
  await mkdir(path.dirname(filename), { recursive: true });
  const temporary = `${filename}.litellm-dark-mode-${process.pid}-${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { mode });
    await rename(temporary, filename);
    await chmod(filename, mode);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function fileMode(filename) {
  try {
    return (await stat(filename)).mode & 0o777;
  } catch {
    return 0o644;
  }
}

function safeManifestRelativePath(relativePath) {
  return (
    typeof relativePath === "string" &&
    !path.isAbsolute(relativePath) &&
    !relativePath.split(/[\\/]/).includes("..")
  );
}

async function loadManifest(dashboardRoot) {
  const manifestPath = path.join(dashboardRoot, MANIFEST_NAME);
  if (!(await pathExists(manifestPath))) return null;

  try {
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION || typeof manifest.files !== "object") {
      throw new Error("unsupported manifest schema");
    }
    for (const relativePath of [...Object.keys(manifest.files), ...Object.keys(manifest.createdFiles ?? {})]) {
      if (!safeManifestRelativePath(relativePath)) throw new Error("unsafe path in manifest");
    }
    return manifest;
  } catch (error) {
    throw new LiteLLMDarkModeError(
      `Cannot read ${MANIFEST_NAME}: ${error.message}`,
      "INVALID_MANIFEST",
    );
  }
}

export async function getPatchStatus(inputPath = ".") {
  const dashboardRoot = await resolveDashboardRoot(inputPath);
  const manifest = await loadManifest(dashboardRoot);
  if (!manifest) return { status: "not-installed", dashboardRoot, mismatches: [] };

  const mismatches = [];
  for (const [relativePath, record] of Object.entries(manifest.files)) {
    const filename = path.join(dashboardRoot, relativePath);
    try {
      const current = await readFile(filename);
      if (sha256(current) !== record.afterSha256) mismatches.push(relativePath);
    } catch {
      mismatches.push(relativePath);
    }
  }
  for (const [relativePath, record] of Object.entries(manifest.createdFiles ?? {})) {
    const filename = path.join(dashboardRoot, relativePath);
    try {
      const current = await readFile(filename);
      if (sha256(current) !== record.sha256) mismatches.push(relativePath);
    } catch {
      mismatches.push(relativePath);
    }
  }

  return {
    status: mismatches.length === 0 ? "installed" : "modified",
    dashboardRoot,
    mismatches,
    packageVersion: manifest.packageVersion,
    sourceRevision: manifest.sourceRevision,
  };
}

export async function applyPatch(inputPath = ".", { dryRun = false } = {}) {
  const dashboardRoot = await resolveDashboardRoot(inputPath);
  const existingManifest = await loadManifest(dashboardRoot);
  if (existingManifest) {
    const status = await getPatchStatus(dashboardRoot);
    if (status.status === "installed") {
      return { ...status, status: "already-installed", changes: [] };
    }
    throw new LiteLLMDarkModeError(
      `An existing patch was modified in: ${status.mismatches.join(", ")}. Undo it or use a fresh clone before reapplying.`,
      "PATCH_MODIFIED",
    );
  }

  const darkCssPath = path.join(dashboardRoot, DARK_CSS_RELATIVE_PATH);
  if (await pathExists(darkCssPath)) {
    throw new LiteLLMDarkModeError(
      `${DARK_CSS_RELATIVE_PATH} already exists without a manifest. Refusing to overwrite it.`,
      "CSS_CONFLICT",
    );
  }

  const originals = await readSourceFiles(dashboardRoot);
  const patched = {
    [SOURCE_PATHS.globals]: patchGlobals(originals[SOURCE_PATHS.globals]),
    [SOURCE_PATHS.layout]: patchLayout(originals[SOURCE_PATHS.layout]),
    [SOURCE_PATHS.antdProvider]: patchAntdProvider(originals[SOURCE_PATHS.antdProvider]),
  };
  const darkCss = await readFile(DARK_CSS_URL);
  const changes = [...Object.keys(patched), DARK_CSS_RELATIVE_PATH, MANIFEST_NAME];

  if (dryRun) {
    return { status: "would-install", dashboardRoot, changes };
  }

  const fileRecords = {};
  for (const relativePath of Object.keys(patched)) {
    fileRecords[relativePath] = {
      beforeSha256: sha256(originals[relativePath]),
      afterSha256: sha256(patched[relativePath]),
      beforeBase64: Buffer.from(originals[relativePath], "utf8").toString("base64"),
      mode: await fileMode(path.join(dashboardRoot, relativePath)),
    };
  }

  const manifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    packageVersion: PACKAGE_VERSION,
    installedAt: new Date().toISOString(),
    sourceRevision: await getGitRevision(dashboardRoot),
    files: fileRecords,
    createdFiles: {
      [DARK_CSS_RELATIVE_PATH]: { sha256: sha256(darkCss), mode: 0o644 },
    },
  };

  const manifestPath = path.join(dashboardRoot, MANIFEST_NAME);
  try {
    for (const [relativePath, content] of Object.entries(patched)) {
      await atomicWrite(path.join(dashboardRoot, relativePath), content, fileRecords[relativePath].mode);
    }
    await atomicWrite(darkCssPath, darkCss, 0o644);
    await atomicWrite(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 0o644);
  } catch (error) {
    for (const [relativePath, content] of Object.entries(originals)) {
      await atomicWrite(path.join(dashboardRoot, relativePath), content, fileRecords[relativePath]?.mode ?? 0o644).catch(
        () => {},
      );
    }
    await rm(darkCssPath, { force: true }).catch(() => {});
    await rm(manifestPath, { force: true }).catch(() => {});
    throw new LiteLLMDarkModeError(`Patch transaction failed and was rolled back: ${error.message}`, "WRITE_FAILED");
  }

  return {
    status: "installed",
    dashboardRoot,
    changes,
    sourceRevision: manifest.sourceRevision,
    packageVersion: PACKAGE_VERSION,
  };
}

export async function undoPatch(inputPath = ".", { dryRun = false, force = false } = {}) {
  const dashboardRoot = await resolveDashboardRoot(inputPath);
  const manifest = await loadManifest(dashboardRoot);
  if (!manifest) return { status: "not-installed", dashboardRoot, changes: [] };

  const status = await getPatchStatus(dashboardRoot);
  if (status.status === "modified" && !force) {
    throw new LiteLLMDarkModeError(
      `Refusing to overwrite post-patch edits in: ${status.mismatches.join(", ")}. Use --force only if restoring the recorded originals is intentional.`,
      "UNDO_CONFLICT",
    );
  }

  const changes = [...Object.keys(manifest.files), ...Object.keys(manifest.createdFiles ?? {}), MANIFEST_NAME];
  if (dryRun) return { status: "would-undo", dashboardRoot, changes, mismatches: status.mismatches };

  for (const [relativePath, record] of Object.entries(manifest.files)) {
    const original = Buffer.from(record.beforeBase64, "base64");
    await atomicWrite(path.join(dashboardRoot, relativePath), original, record.mode ?? 0o644);
  }
  for (const relativePath of Object.keys(manifest.createdFiles ?? {})) {
    await rm(path.join(dashboardRoot, relativePath), { force: true });
  }
  await rm(path.join(dashboardRoot, MANIFEST_NAME), { force: true });

  return { status: "removed", dashboardRoot, changes, forced: force && status.mismatches.length > 0 };
}
