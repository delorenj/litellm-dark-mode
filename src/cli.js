import path from "node:path";
import {
  buildDockerImage,
  DEFAULT_DARK_IMAGE,
  DEFAULT_LITELLM_IMAGE,
  formatDockerBuildCommand,
} from "./docker.js";
import { applyPatch, getPatchStatus, LiteLLMDarkModeError, PACKAGE_VERSION, undoPatch } from "./patcher.js";

const HELP = `
litellm-dark-mode v${PACKAGE_VERSION}

Force the LiteLLM dashboard into dark mode while the upstream PR enjoys its
extended stay in review.

Usage:
  litellm-dark-mode [path] [options]
  litellm-dark-mode docker [options]

Arguments:
  path              LiteLLM repo root or ui/litellm-dashboard (default: .)

Docker options:
  --image IMAGE     LiteLLM base image (default: ${DEFAULT_LITELLM_IMAGE})
  --tag IMAGE       Tag for the derived image (default: ${DEFAULT_DARK_IMAGE})

Options:
  --check           Verify that the patch is installed and untouched
  --dry-run         Show what would change without writing anything
  --undo             Restore the exact source files recorded during install
  --force            With --undo, restore originals despite later edits
  --quiet            Print only errors
  --no-snark         Keep the terminal painfully professional
  -h, --help         Show this help
  -v, --version      Show the package version
`;

export function parseArgs(argv) {
  const dockerMode = argv[0] === "docker";
  const argumentsToParse = dockerMode ? argv.slice(1) : argv;
  const options = {
    action: dockerMode ? "docker" : "apply",
    mode: dockerMode ? "docker" : "source",
    dryRun: false,
    force: false,
    quiet: false,
    snark: true,
    path: ".",
    image: DEFAULT_LITELLM_IMAGE,
    tag: DEFAULT_DARK_IMAGE,
  };
  const positional = [];

  for (let index = 0; index < argumentsToParse.length; index += 1) {
    const argument = argumentsToParse[index];
    if (argument === "--") {
      positional.push(...argumentsToParse.slice(index + 1));
      break;
    }
    if (argument === "--check") {
      if (dockerMode) throw new LiteLLMDarkModeError("Docker images are immutable; check the image label instead.", "USAGE");
      options.action = "check";
    } else if (argument === "--undo") {
      if (dockerMode) throw new LiteLLMDarkModeError("Undo Docker mode by restoring the original image reference.", "USAGE");
      options.action = "undo";
    }
    else if (argument === "--dry-run") options.dryRun = true;
    else if (argument === "--force") options.force = true;
    else if (argument === "--quiet") options.quiet = true;
    else if (argument === "--no-snark") options.snark = false;
    else if (argument === "--image" || argument === "--tag") {
      if (!dockerMode) throw new LiteLLMDarkModeError(`${argument} is only valid after the docker subcommand.`, "USAGE");
      const value = argumentsToParse[index + 1];
      if (!value || value.startsWith("-")) {
        throw new LiteLLMDarkModeError(`${argument} requires a Docker image reference.`, "USAGE");
      }
      if (argument === "--image") options.image = value;
      else options.tag = value;
      index += 1;
    }
    else if (argument === "-h" || argument === "--help") options.action = "help";
    else if (argument === "-v" || argument === "--version") options.action = "version";
    else if (argument.startsWith("-")) {
      throw new LiteLLMDarkModeError(`Unknown option: ${argument}`, "USAGE");
    } else positional.push(argument);
  }

  if (dockerMode && positional.length > 0) {
    throw new LiteLLMDarkModeError("Docker mode takes options, not a source path.", "USAGE");
  }
  if (!dockerMode && positional.length > 1) {
    throw new LiteLLMDarkModeError("Pass exactly one LiteLLM source path.", "USAGE");
  }
  if (!dockerMode && positional.length === 1) options.path = positional[0];
  if (options.force && options.action !== "undo") {
    throw new LiteLLMDarkModeError("--force is intentionally limited to --undo.", "USAGE");
  }

  return options;
}

function writer(stream) {
  return (message = "") => stream.write(`${message}\n`);
}

function relativeDisplay(target) {
  const relative = path.relative(process.cwd(), target);
  return relative && !relative.startsWith("..") ? relative : target;
}

function printChanges(out, changes, verb) {
  for (const change of changes) out(`  ${verb} ${change}`);
}

export async function runCli(argv, streams = { stdout: process.stdout, stderr: process.stderr }) {
  const out = writer(streams.stdout);
  const errorOut = writer(streams.stderr);

  try {
    const options = parseArgs(argv);
    if (options.action === "help") {
      out(HELP.trim());
      return 0;
    }
    if (options.action === "version") {
      out(PACKAGE_VERSION);
      return 0;
    }

    if (!options.quiet) {
      out(`litellm-dark-mode v${PACKAGE_VERSION}`);
      if (options.snark && options.action === "docker") {
        out("Your container is disposable. The interrogation lamp no longer has to be.");
      } else if (options.snark && options.action === "apply") {
        out("Upstream has the tokens. The open PR has the CSS. Your retinas have waited long enough.");
      }
    }

    if (options.action === "docker") {
      const result = await buildDockerImage(
        { image: options.image, tag: options.tag, dryRun: options.dryRun },
        streams,
      );
      if (!options.quiet) {
        if (result.status === "would-build") out(`Would run: ${formatDockerBuildCommand(result)}`);
        else out(`Built ${result.tag} from ${result.image}.`);
        out(`Use it in Compose with: image: ${result.tag}`);
      }
      return 0;
    }

    if (options.action === "check") {
      const result = await getPatchStatus(options.path);
      if (result.status === "installed") {
        if (!options.quiet) out(`Dark mode is installed and intact in ${relativeDisplay(result.dashboardRoot)}.`);
        return 0;
      }
      if (result.status === "modified") {
        errorOut(`Dark mode was installed, but these managed files changed: ${result.mismatches.join(", ")}`);
        return 2;
      }
      errorOut(`Dark mode is not installed in ${relativeDisplay(result.dashboardRoot)}.`);
      return 1;
    }

    if (options.action === "undo") {
      const result = await undoPatch(options.path, { dryRun: options.dryRun, force: options.force });
      if (result.status === "not-installed") {
        if (!options.quiet) out("Nothing to undo. LiteLLM remains at factory brightness.");
        return 0;
      }
      if (!options.quiet) {
        out(`${result.status === "would-undo" ? "Would restore" : "Restored"} ${relativeDisplay(result.dashboardRoot)}.`);
        printChanges(out, result.changes, result.status === "would-undo" ? "would restore/remove" : "restored/removed");
        if (result.forced) out("Forced restore completed; post-patch edits in managed files were discarded.");
      }
      return 0;
    }

    const result = await applyPatch(options.path, { dryRun: options.dryRun });
    if (!options.quiet) {
      if (result.status === "already-installed") {
        out(`Already dark. Re-running the command does not make it gothier: ${relativeDisplay(result.dashboardRoot)}.`);
      } else {
        out(`${result.status === "would-install" ? "Would patch" : "Patched"} ${relativeDisplay(result.dashboardRoot)}:`);
        printChanges(out, result.changes, result.status === "would-install" ? "would update" : "updated");
        if (result.sourceRevision) out(`  LiteLLM source revision: ${result.sourceRevision}`);
        if (result.status === "installed") out("Rebuild the dashboard; source is dark now, compiled photons are not.");
      }
    }
    return 0;
  } catch (error) {
    const prefix = error instanceof LiteLLMDarkModeError ? error.code : "UNEXPECTED_ERROR";
    errorOut(`litellm-dark-mode [${prefix}]: ${error.message}`);
    if (prefix === "USAGE") errorOut("Run with --help for usage.");
    return 1;
  }
}
