import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { getDockerBuildSpec } from "../src/docker.js";

const execFileAsync = promisify(execFile);
const PATCH_SCRIPT = new URL("../docker/patch-image.py", import.meta.url);
const DARK_CSS = new URL("../assets/litellm-dark-mode.css", import.meta.url);

function sha256(content) {
  return createHash("sha256").update(content).digest("hex");
}

async function createExportFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "litellm-dark-mode-export-"));
  const chunks = path.join(root, "_next", "static", "chunks");
  await mkdir(path.join(root, "login"), { recursive: true });
  await mkdir(chunks, { recursive: true });
  const html = '<!doctype html><html lang="en"><head><link href="/_next/a.css" rel="stylesheet"></head><body></body></html>';
  await writeFile(path.join(root, "index.html"), html);
  await writeFile(path.join(root, "login", "index.html"), html);
  await writeFile(path.join(chunks, "a.css"), "body{background:white}\n");
  await writeFile(path.join(chunks, "b.css"), ".card{color:black}\n");
  return root;
}

async function runImagePatcher(root, version = "0.2.0") {
  return execFileAsync("python3", [
    PATCH_SCRIPT.pathname,
    "--root",
    root,
    "--css",
    DARK_CSS.pathname,
    "--version",
    version,
  ]);
}

test("Docker build spec passes image references as arguments without a shell", () => {
  const spec = getDockerBuildSpec({
    image: "ghcr.io/berriai/litellm@sha256:abc123",
    tag: "litellm-dark-mode:test",
  });
  assert.equal(spec.command, "docker");
  assert.ok(spec.args.includes("LITELLM_IMAGE=ghcr.io/berriai/litellm@sha256:abc123"));
  assert.ok(spec.args.includes("litellm-dark-mode:test"));
  assert.equal(spec.args.at(-1), spec.cwd);
});

test("Docker image patcher forces dark mode across an exported dashboard", async () => {
  const root = await createExportFixture();
  const first = JSON.parse((await runImagePatcher(root)).stdout);
  assert.equal(first.status, "installed");
  assert.equal(first.htmlFiles, 2);
  assert.equal(first.cssFiles, 2);

  const html = await readFile(path.join(root, "login", "index.html"), "utf8");
  assert.match(html, /<html[^>]+class="dark"/);
  assert.match(html, /data-litellm-dark-mode="docker-0\.2\.0"/);
  assert.match(html, /color-scheme:dark/);
  assert.match(html, /data-litellm-dark-mode-bootstrap="docker-0\.2\.0"/);

  const css = await readFile(path.join(root, "_next", "static", "chunks", "a.css"), "utf8");
  assert.match(css, /litellm-dark-mode:docker version=0\.2\.0/);
  assert.match(css, /\.dark \.ant-card/);

  const manifest = JSON.parse(await readFile(path.join(root, ".litellm-dark-mode-docker.json"), "utf8"));
  assert.equal(manifest.packageVersion, "0.2.0");
  assert.equal(manifest.files.length, 4);
  for (const record of manifest.files) {
    assert.equal(sha256(await readFile(path.join(root, record.path))), record.afterSha256);
  }

  const second = JSON.parse((await runImagePatcher(root)).stdout);
  assert.equal(second.status, "already-installed");
});

test("Docker image patcher rejects a modified installed export", async () => {
  const root = await createExportFixture();
  await runImagePatcher(root);
  const filename = path.join(root, "index.html");
  await writeFile(filename, `${await readFile(filename, "utf8")}<!-- changed -->`);
  await assert.rejects(() => runImagePatcher(root), /PATCH_CONFLICT/);
});

test("Docker image patcher fails closed on a partial prior patch", async () => {
  const root = await createExportFixture();
  const filename = path.join(root, "index.html");
  await writeFile(
    filename,
    (await readFile(filename, "utf8")).replace("<html", '<html data-litellm-dark-mode="docker-0.1.0"'),
  );
  await assert.rejects(() => runImagePatcher(root), /PATCH_CONFLICT/);
});
