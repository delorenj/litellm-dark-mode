import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LiteLLMDarkModeError, PACKAGE_VERSION } from "./patcher.js";

export const DEFAULT_LITELLM_IMAGE = "ghcr.io/berriai/litellm:main-stable";
export const DEFAULT_DARK_IMAGE = "litellm-dark-mode:local";

const PACKAGE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOCKERFILE_PATH = path.join(PACKAGE_ROOT, "docker", "Dockerfile");

function validateImageReference(value, label) {
  if (typeof value !== "string" || value.length === 0 || value !== value.trim()) {
    throw new LiteLLMDarkModeError(`${label} must be a non-empty Docker image reference.`, "USAGE");
  }
  if (/\s|[\u0000-\u001f\u007f]/.test(value) || value.startsWith("-")) {
    throw new LiteLLMDarkModeError(`${label} is not a safe Docker image reference: ${value}`, "USAGE");
  }
  return value;
}

export function getDockerBuildSpec({ image = DEFAULT_LITELLM_IMAGE, tag = DEFAULT_DARK_IMAGE } = {}) {
  const baseImage = validateImageReference(image, "--image");
  const outputTag = validateImageReference(tag, "--tag");
  return {
    command: "docker",
    args: [
      "build",
      "--build-arg",
      `LITELLM_IMAGE=${baseImage}`,
      "--build-arg",
      `LITELLM_DARK_MODE_VERSION=${PACKAGE_VERSION}`,
      "--tag",
      outputTag,
      "--file",
      DOCKERFILE_PATH,
      PACKAGE_ROOT,
    ],
    cwd: PACKAGE_ROOT,
    image: baseImage,
    tag: outputTag,
  };
}

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:@+=,-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function formatDockerBuildCommand(spec) {
  return [spec.command, ...spec.args].map(shellQuote).join(" ");
}

export async function buildDockerImage(
  { image = DEFAULT_LITELLM_IMAGE, tag = DEFAULT_DARK_IMAGE, dryRun = false } = {},
  { stdout = process.stdout, stderr = process.stderr, spawnImpl = spawn } = {},
) {
  const spec = getDockerBuildSpec({ image, tag });
  if (dryRun) return { status: "would-build", ...spec };

  try {
    await access(DOCKERFILE_PATH);
  } catch {
    throw new LiteLLMDarkModeError(
      `Docker build recipe is missing from this package: ${DOCKERFILE_PATH}`,
      "DOCKER_RECIPE_MISSING",
    );
  }

  await new Promise((resolve, reject) => {
    const child = spawnImpl(spec.command, spec.args, {
      cwd: spec.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.on("data", (chunk) => stdout.write(chunk));
    child.stderr?.on("data", (chunk) => stderr.write(chunk));
    child.once("error", (error) => {
      reject(
        new LiteLLMDarkModeError(
          `Could not start Docker: ${error.message}`,
          error.code === "ENOENT" ? "DOCKER_NOT_FOUND" : "DOCKER_START_FAILED",
        ),
      );
    });
    child.once("close", (code, signal) => {
      if (code === 0) resolve();
      else {
        reject(
          new LiteLLMDarkModeError(
            `Docker build failed${signal ? ` from signal ${signal}` : ` with exit code ${code}`}.`,
            "DOCKER_BUILD_FAILED",
          ),
        );
      }
    });
  });

  return { status: "built", ...spec };
}
