# litellm-dark-mode

LiteLLM's dashboard already contains dark tokens. Multiple dark-mode pull requests already contain the rest. Your monitor, somehow, is still being used as an interrogation lamp.

This package ends the committee meeting:

```bash
npx litellm-dark-mode /path/to/cloned/litellm
```

Then rebuild the dashboard normally. The patch is build-time, browser-independent, deterministic, and safe to rerun.

Already running LiteLLM from an image instead of a source checkout? Build a thin,
immutable dark-mode image on top of the exact LiteLLM image you already trust:

```bash
npx litellm-dark-mode docker \
  --image ghcr.io/berriai/litellm@sha256:YOUR_PINNED_DIGEST \
  --tag litellm-dark-mode:local
```

## What it changes

The CLI accepts either a LiteLLM repository root or its `ui/litellm-dashboard` directory. It:

1. forces the root `<html>` element into LiteLLM's existing `.dark` variant before first paint;
2. enables Ant Design's official `darkAlgorithm`;
3. imports a comprehensive compatibility layer for LiteLLM's hard-coded Tailwind, Tremor, and portal-rendered Ant Design surfaces;
4. writes `.litellm-dark-mode.json` so every change is verifiable and exactly reversible.

It does not rewrite built, hashed bundles and it does not mutate a running container. Patch source, then run LiteLLM's dashboard build.

## Commands

```bash
# Apply. The current directory is the default target.
npx litellm-dark-mode .

# Preview the exact managed paths.
npx litellm-dark-mode . --dry-run

# Verify nothing drifted after installation.
npx litellm-dark-mode . --check

# Restore the exact pre-patch source.
npx litellm-dark-mode . --undo

# Suppress the editorial commentary, if joy is forbidden in your CI too.
npx litellm-dark-mode . --no-snark
```

`--undo` refuses to overwrite later edits to managed files. `--undo --force` restores the recorded originals anyway and should be used deliberately.

Before updating a long-lived LiteLLM clone, remove the patch, update, and apply it again so Git never has to guess which side owns the same three seams:

```bash
npx litellm-dark-mode . --undo
git pull --ff-only
npx litellm-dark-mode .
```

## Typical source build

```bash
git clone https://github.com/BerriAI/litellm.git
npx litellm-dark-mode ./litellm
cd litellm/ui/litellm-dashboard
npm ci
npm run build
```

LiteLLM's own build and image assembly steps remain authoritative; this package only patches the dashboard source tree.

## Docker deployments

Docker mode creates a derived image; it never edits a running container. The
base image, entrypoint, command, environment, and application data remain
unchanged. The added layer:

1. locates LiteLLM's packaged static dashboard export;
2. validates every exported HTML page and CSS chunk before writing;
3. forces the root `dark` class before hydration and appends the same
   compatibility CSS used by source mode;
4. records before/after hashes in `.litellm-dark-mode-docker.json` inside the
   image and labels the image with the patcher version.

Use the resulting tag in Compose:

```yaml
services:
  litellm:
    image: litellm-dark-mode:local
```

Preview the exact build command without touching Docker:

```bash
npx litellm-dark-mode docker \
  --image ghcr.io/berriai/litellm@sha256:YOUR_PINNED_DIGEST \
  --tag litellm-dark-mode:local \
  --dry-run
```

To undo Docker mode, restore the original `image:` reference and recreate the
service. When upgrading LiteLLM, rerun the Docker command with the new pinned
digest. The build fails closed if LiteLLM stops shipping the expected static
HTML/CSS export, or if the base image was already partially patched.

Source mode remains the most complete integration because it also selects Ant
Design's native dark algorithm before compilation. Docker mode targets prebuilt
official images, where the source compiler is no longer available, and uses the
compatibility layer to cover those shipped components instead.

## Compatibility policy

The patcher targets the current Tailwind v4 dashboard and validates every source seam before writing. When upstream moves a relevant file, it fails closed with a useful error instead of spraying a half-applied theme across the tree. Writes are atomic and roll back on failure.

Source mode is validated against LiteLLM `litellm_internal_staging` revision `69b0296ca342` from 2026-08-13. Docker mode is validated against the official image's packaged export and deliberately keys compatibility to structure rather than mutable chunk names. A normal upstream dark mode should eventually make this package obsolete. That will be a successful deprecation, not a tragedy.

## Credit where it is overdue

The compatibility CSS is adapted from the MIT-licensed work by CryptoCanuck in [BerriAI/litellm#18293](https://github.com/BerriAI/litellm/pull/18293) and eanrollings' current rebase in [#35615](https://github.com/BerriAI/litellm/pull/35615). This package supplies the narrow forced-dark installer, integrity manifest, reversal path, and release vehicle; it does not pretend those contributors did not already solve the hard visual coverage problem.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing details.

## License

MIT
