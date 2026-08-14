# litellm-dark-mode

LiteLLM's dashboard already contains dark tokens. Multiple dark-mode pull requests already contain the rest. Your monitor, somehow, is still being used as an interrogation lamp.

This package ends the committee meeting:

```bash
npx litellm-dark-mode /path/to/cloned/litellm
```

Then rebuild the dashboard normally. The patch is build-time, browser-independent, deterministic, and safe to rerun.

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

## Compatibility policy

The patcher targets the current Tailwind v4 dashboard and validates every source seam before writing. When upstream moves a relevant file, it fails closed with a useful error instead of spraying a half-applied theme across the tree. Writes are atomic and roll back on failure.

The first release is validated against LiteLLM `litellm_internal_staging` revision `69b0296ca342` from 2026-08-13. A normal upstream dark mode should eventually make this package obsolete. That will be a successful deprecation, not a tragedy.

## Credit where it is overdue

The compatibility CSS is adapted from the MIT-licensed work by CryptoCanuck in [BerriAI/litellm#18293](https://github.com/BerriAI/litellm/pull/18293) and eanrollings' current rebase in [#35615](https://github.com/BerriAI/litellm/pull/35615). This package supplies the narrow forced-dark installer, integrity manifest, reversal path, and release vehicle; it does not pretend those contributors did not already solve the hard visual coverage problem.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for licensing details.

## License

MIT
