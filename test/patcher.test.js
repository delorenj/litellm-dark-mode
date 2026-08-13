import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyPatch,
  getPatchStatus,
  MANIFEST_NAME,
  PACKAGE_VERSION,
  resolveDashboardRoot,
  undoPatch,
} from "../src/patcher.js";

const ORIGINAL_GLOBALS = `@layer theme, base, antd, components, utilities;

@import "tailwindcss";
@import "tw-animate-css";
@import "./tremor-v3-compat.css" layer(utilities);

@custom-variant dark (&:where(.dark, .dark *));

:root { --background: white; }
.dark { --background: black; }
`;

const ORIGINAL_LAYOUT = `import "./globals.css";

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`;

const ORIGINAL_PROVIDER = `"use client";

import React from "react";
import { ConfigProvider, notification, message } from "antd";

export default function AntdGlobalProvider({ children }) {
  return <ConfigProvider theme={{ cssVar: true }}>{children}</ConfigProvider>;
}
`;

async function createFixture() {
  const parent = await mkdtemp(path.join(os.tmpdir(), "litellm-dark-mode-test-"));
  const dashboard = path.join(parent, "ui", "litellm-dashboard");
  await mkdir(path.join(dashboard, "src", "app"), { recursive: true });
  await mkdir(path.join(dashboard, "src", "contexts"), { recursive: true });
  await writeFile(path.join(dashboard, "package.json"), '{"name":"litellm-dashboard"}\n');
  await writeFile(path.join(dashboard, "src", "app", "globals.css"), ORIGINAL_GLOBALS);
  await writeFile(path.join(dashboard, "src", "app", "layout.tsx"), ORIGINAL_LAYOUT);
  await writeFile(path.join(dashboard, "src", "contexts", "AntdGlobalProvider.tsx"), ORIGINAL_PROVIDER);
  return { parent, dashboard };
}

async function exists(filename) {
  try {
    await access(filename);
    return true;
  } catch {
    return false;
  }
}

test("exported version matches package metadata", async () => {
  const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(PACKAGE_VERSION, packageJson.version);
});

test("resolves both a LiteLLM repo root and the dashboard root", async () => {
  const fixture = await createFixture();
  assert.equal(await resolveDashboardRoot(fixture.parent), fixture.dashboard);
  assert.equal(await resolveDashboardRoot(fixture.dashboard), fixture.dashboard);
});

test("applies a forced, library-aware dark mode and records a manifest", async () => {
  const fixture = await createFixture();
  const result = await applyPatch(fixture.parent);

  assert.equal(result.status, "installed");
  assert.match(await readFile(path.join(fixture.dashboard, "src/app/globals.css"), "utf8"), /litellm-dark-mode\.css/);
  assert.match(await readFile(path.join(fixture.dashboard, "src/app/layout.tsx"), "utf8"), /className="dark"/);
  assert.match(await readFile(path.join(fixture.dashboard, "src/app/layout.tsx"), "utf8"), /colorScheme: "dark"/);
  assert.match(
    await readFile(path.join(fixture.dashboard, "src/contexts/AntdGlobalProvider.tsx"), "utf8"),
    /litellmDarkModeAntdTheme\.darkAlgorithm/,
  );
  assert.match(await readFile(path.join(fixture.dashboard, "src/app/litellm-dark-mode.css"), "utf8"), /\.dark/);
  assert.equal(await exists(path.join(fixture.dashboard, MANIFEST_NAME)), true);
  assert.equal((await getPatchStatus(fixture.dashboard)).status, "installed");
});

test("is idempotent", async () => {
  const fixture = await createFixture();
  await applyPatch(fixture.parent);
  const second = await applyPatch(fixture.parent);
  assert.equal(second.status, "already-installed");
  assert.deepEqual(second.changes, []);
});

test("dry-run describes changes without touching the tree", async () => {
  const fixture = await createFixture();
  const result = await applyPatch(fixture.parent, { dryRun: true });
  assert.equal(result.status, "would-install");
  assert.equal(await readFile(path.join(fixture.dashboard, "src/app/layout.tsx"), "utf8"), ORIGINAL_LAYOUT);
  assert.equal(await exists(path.join(fixture.dashboard, MANIFEST_NAME)), false);
});

test("undo restores exact originals and removes managed files", async () => {
  const fixture = await createFixture();
  await applyPatch(fixture.parent);
  const result = await undoPatch(fixture.parent);

  assert.equal(result.status, "removed");
  assert.equal(await readFile(path.join(fixture.dashboard, "src/app/globals.css"), "utf8"), ORIGINAL_GLOBALS);
  assert.equal(await readFile(path.join(fixture.dashboard, "src/app/layout.tsx"), "utf8"), ORIGINAL_LAYOUT);
  assert.equal(
    await readFile(path.join(fixture.dashboard, "src/contexts/AntdGlobalProvider.tsx"), "utf8"),
    ORIGINAL_PROVIDER,
  );
  assert.equal(await exists(path.join(fixture.dashboard, "src/app/litellm-dark-mode.css")), false);
  assert.equal(await exists(path.join(fixture.dashboard, MANIFEST_NAME)), false);
});

test("refuses to erase post-patch edits unless forced", async () => {
  const fixture = await createFixture();
  await applyPatch(fixture.parent);
  const layoutPath = path.join(fixture.dashboard, "src/app/layout.tsx");
  await writeFile(layoutPath, `${await readFile(layoutPath, "utf8")}\n// local edit\n`);

  assert.equal((await getPatchStatus(fixture.parent)).status, "modified");
  await assert.rejects(() => undoPatch(fixture.parent), /Refusing to overwrite post-patch edits/);
  const result = await undoPatch(fixture.parent, { force: true });
  assert.equal(result.forced, true);
  assert.equal(await readFile(layoutPath, "utf8"), ORIGINAL_LAYOUT);
});

test("fails closed when the expected Ant Design seam has moved", async () => {
  const fixture = await createFixture();
  await writeFile(
    path.join(fixture.dashboard, "src/contexts/AntdGlobalProvider.tsx"),
    ORIGINAL_PROVIDER.replace("theme={{ cssVar: true }}", "theme={someCustomTheme}"),
  );
  await assert.rejects(() => applyPatch(fixture.parent), /Expected one simple Ant Design theme config/);
  assert.equal(await exists(path.join(fixture.dashboard, MANIFEST_NAME)), false);
});
