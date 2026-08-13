import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/cli.js";

test("CLI defaults to applying in the current directory", () => {
  assert.deepEqual(parseArgs([]), {
    action: "apply",
    dryRun: false,
    force: false,
    quiet: false,
    snark: true,
    path: ".",
  });
});

test("CLI parses reversible and low-noise modes", () => {
  assert.deepEqual(parseArgs(["/src/litellm", "--undo", "--dry-run", "--force", "--quiet", "--no-snark"]), {
    action: "undo",
    dryRun: true,
    force: true,
    quiet: true,
    snark: false,
    path: "/src/litellm",
  });
});

test("CLI rejects force outside undo", () => {
  assert.throws(() => parseArgs(["--force"]), /intentionally limited to --undo/);
});
