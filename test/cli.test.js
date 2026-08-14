import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/cli.js";

test("CLI defaults to applying in the current directory", () => {
  assert.deepEqual(parseArgs([]), {
    action: "apply",
    mode: "source",
    dryRun: false,
    force: false,
    quiet: false,
    snark: true,
    path: ".",
    image: "ghcr.io/berriai/litellm:main-stable",
    tag: "litellm-dark-mode:local",
  });
});

test("CLI parses reversible and low-noise modes", () => {
  assert.deepEqual(parseArgs(["/src/litellm", "--undo", "--dry-run", "--force", "--quiet", "--no-snark"]), {
    action: "undo",
    mode: "source",
    dryRun: true,
    force: true,
    quiet: true,
    snark: false,
    path: "/src/litellm",
    image: "ghcr.io/berriai/litellm:main-stable",
    tag: "litellm-dark-mode:local",
  });
});

test("CLI parses a Docker derived-image build", () => {
  assert.deepEqual(
    parseArgs([
      "docker",
      "--image",
      "ghcr.io/berriai/litellm@sha256:abc123",
      "--tag",
      "litellm-dark-mode:test",
      "--dry-run",
    ]),
    {
      action: "docker",
      mode: "docker",
      dryRun: true,
      force: false,
      quiet: false,
      snark: true,
      path: ".",
      image: "ghcr.io/berriai/litellm@sha256:abc123",
      tag: "litellm-dark-mode:test",
    },
  );
});

test("CLI keeps Docker-only options out of source mode", () => {
  assert.throws(() => parseArgs(["--image", "example/image:tag"]), /only valid after the docker subcommand/);
  assert.throws(() => parseArgs(["docker", "."]), /takes options, not a source path/);
  assert.throws(() => parseArgs(["docker", "--undo"]), /restoring the original image reference/);
});

test("CLI rejects force outside undo", () => {
  assert.throws(() => parseArgs(["--force"]), /intentionally limited to --undo/);
});
