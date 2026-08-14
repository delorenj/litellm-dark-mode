#!/usr/bin/env python3
"""Patch LiteLLM's shipped static dashboard inside an immutable derived image."""

from __future__ import annotations

import argparse
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import re
import tempfile


MANIFEST_NAME = ".litellm-dark-mode-docker.json"
SCHEMA_VERSION = 1


class PatchError(RuntimeError):
    def __init__(self, message: str, code: str = "PATCH_ERROR") -> None:
        super().__init__(message)
        self.code = code


def sha256(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


def resolve_export_root(explicit_root: str | None) -> Path:
    if explicit_root:
        root = Path(explicit_root).resolve()
    else:
        spec = importlib.util.find_spec("litellm")
        if spec is None or spec.origin is None:
            raise PatchError("Could not locate the installed litellm package.", "LITELLM_NOT_FOUND")
        root = Path(spec.origin).resolve().parent / "proxy" / "_experimental" / "out"

    if not root.is_dir():
        raise PatchError(
            f"LiteLLM dashboard export was not found at {root}.",
            "DASHBOARD_EXPORT_NOT_FOUND",
        )
    return root


def append_attribute(tag: str, attribute: str) -> str:
    return f"{tag[:-1]} {attribute}>"


def patch_html_tag(tag: str, marker: str) -> str:
    class_match = re.search(r'\bclass=(?P<quote>["\'])(?P<classes>.*?)(?P=quote)', tag, re.IGNORECASE)
    if class_match:
        classes = class_match.group("classes").split()
        if "dark" not in classes:
            classes.append("dark")
        replacement = f'class={class_match.group("quote")}{" ".join(classes)}{class_match.group("quote")}'
        tag = f"{tag[:class_match.start()]}{replacement}{tag[class_match.end():]}"
    else:
        tag = append_attribute(tag, 'class="dark"')

    style_match = re.search(r'\bstyle=(?P<quote>["\'])(?P<style>.*?)(?P=quote)', tag, re.IGNORECASE)
    if style_match:
        style = style_match.group("style").rstrip().rstrip(";")
        if "color-scheme" not in style.lower():
            style = f"{style};color-scheme:dark" if style else "color-scheme:dark"
        replacement = f'style={style_match.group("quote")}{style}{style_match.group("quote")}'
        tag = f"{tag[:style_match.start()]}{replacement}{tag[style_match.end():]}"
    else:
        tag = append_attribute(tag, 'style="color-scheme:dark"')

    return append_attribute(tag, marker)


def patch_html(content: str, version: str) -> str:
    html_matches = list(re.finditer(r"<html\b[^>]*>", content, re.IGNORECASE))
    if len(html_matches) != 1:
        raise PatchError(
            f"Expected one root <html> tag; found {len(html_matches)}.",
            "UNSUPPORTED_HTML",
        )
    head_matches = list(re.finditer(r"<head\b[^>]*>", content, re.IGNORECASE))
    if len(head_matches) != 1:
        raise PatchError(
            f"Expected one root <head> tag; found {len(head_matches)}.",
            "UNSUPPORTED_HTML",
        )

    marker = f'data-litellm-dark-mode="docker-{version}"'
    html_match = html_matches[0]
    patched_tag = patch_html_tag(html_match.group(0), marker)
    patched = f"{content[:html_match.start()]}{patched_tag}{content[html_match.end():]}"

    bootstrap = (
        f'<script data-litellm-dark-mode-bootstrap="docker-{version}">'
        'document.documentElement.classList.add("dark");'
        'document.documentElement.style.colorScheme="dark";'
        "</script>"
    )
    head_match = re.search(r"<head\b[^>]*>", patched, re.IGNORECASE)
    assert head_match is not None
    return f"{patched[:head_match.end()]}{bootstrap}{patched[head_match.end():]}"


def atomic_write(path: Path, content: bytes, mode: int) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", suffix=".tmp", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(temporary, mode)
        os.replace(temporary, path)
    except Exception:
        temporary.unlink(missing_ok=True)
        raise


def marker_versions(contents: list[str], pattern: str) -> list[str | None]:
    return [match.group(1) if (match := re.search(pattern, content)) else None for content in contents]


def apply_patch(root: Path, css_payload: bytes, version: str) -> dict[str, object]:
    html_files = sorted(root.rglob("*.html"))
    css_files = sorted(root.rglob("*.css"))
    if not html_files or not css_files:
        raise PatchError(
            f"Expected a static export with HTML and CSS; found {len(html_files)} HTML and {len(css_files)} CSS files.",
            "UNSUPPORTED_EXPORT",
        )

    html_text = [path.read_text(encoding="utf-8") for path in html_files]
    css_text = [path.read_text(encoding="utf-8") for path in css_files]
    html_versions = marker_versions(
        html_text,
        r'data-litellm-dark-mode=["\']docker-([^"\']+)["\']',
    )
    css_versions = marker_versions(css_text, r"litellm-dark-mode:docker version=([^\s*]+)")
    existing_versions = {item for item in [*html_versions, *css_versions] if item is not None}
    manifest_path = root / MANIFEST_NAME

    if existing_versions:
        fully_current = (
            existing_versions == {version}
            and all(item == version for item in html_versions)
            and all(item == version for item in css_versions)
            and manifest_path.is_file()
        )
        if fully_current:
            try:
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                records = {
                    record["path"]: record
                    for record in manifest["files"]
                    if isinstance(record, dict) and isinstance(record.get("path"), str)
                }
            except (OSError, json.JSONDecodeError, KeyError, TypeError) as error:
                raise PatchError(
                    f"{MANIFEST_NAME} is unreadable or malformed.",
                    "PATCH_CONFLICT",
                ) from error

            current_files = [*html_files, *css_files]
            hashes_match = (
                manifest.get("packageVersion") == version
                and manifest.get("htmlFiles") == len(html_files)
                and manifest.get("cssFiles") == len(css_files)
                and len(records) == len(current_files)
                and all(
                    (record := records.get(str(path.relative_to(root)))) is not None
                    and record.get("afterSha256") == sha256(path.read_bytes())
                    for path in current_files
                )
            )
            if hashes_match:
                return {
                    "status": "already-installed",
                    "root": str(root),
                    "htmlFiles": len(html_files),
                    "cssFiles": len(css_files),
                    "packageVersion": version,
                }
        raise PatchError(
            "The base image contains a partial or different litellm-dark-mode Docker patch. Use an unmodified LiteLLM base image.",
            "PATCH_CONFLICT",
        )
    if manifest_path.exists():
        raise PatchError(
            f"{MANIFEST_NAME} exists without matching file markers.",
            "PATCH_CONFLICT",
        )

    originals = {path: path.read_bytes() for path in [*html_files, *css_files]}
    modes = {path: path.stat().st_mode & 0o777 for path in originals}
    patched: dict[Path, bytes] = {}
    for path, content in zip(html_files, html_text, strict=True):
        patched[path] = patch_html(content, version).encode("utf-8")

    css_marker = f"/* litellm-dark-mode:docker version={version} */\n".encode()
    normalized_payload = css_payload.rstrip() + b"\n"
    for path in css_files:
        patched[path] = originals[path].rstrip() + b"\n\n" + css_marker + normalized_payload

    records = []
    for path in [*html_files, *css_files]:
        records.append(
            {
                "path": str(path.relative_to(root)),
                "beforeSha256": sha256(originals[path]),
                "afterSha256": sha256(patched[path]),
            }
        )
    manifest = {
        "schemaVersion": SCHEMA_VERSION,
        "packageVersion": version,
        "htmlFiles": len(html_files),
        "cssFiles": len(css_files),
        "files": records,
    }
    manifest_bytes = f"{json.dumps(manifest, indent=2, sort_keys=True)}\n".encode()

    written: list[Path] = []
    try:
        for path, content in patched.items():
            atomic_write(path, content, modes[path])
            written.append(path)
        atomic_write(manifest_path, manifest_bytes, 0o644)
    except Exception as error:
        for path in written:
            atomic_write(path, originals[path], modes[path])
        manifest_path.unlink(missing_ok=True)
        raise PatchError(f"Patch transaction failed and was rolled back: {error}", "WRITE_FAILED") from error

    return {
        "status": "installed",
        "root": str(root),
        "htmlFiles": len(html_files),
        "cssFiles": len(css_files),
        "packageVersion": version,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root", help="Static LiteLLM dashboard export; auto-detected in the image by default")
    parser.add_argument("--css", required=True, help="Compatibility CSS payload")
    parser.add_argument("--version", required=True, help="litellm-dark-mode package version")
    arguments = parser.parse_args()

    if not re.fullmatch(r"[0-9A-Za-z.+-]+", arguments.version):
        raise PatchError("Package version contains unsupported characters.", "INVALID_VERSION")
    root = resolve_export_root(arguments.root)
    css_path = Path(arguments.css).resolve()
    if not css_path.is_file():
        raise PatchError(f"Compatibility CSS was not found at {css_path}.", "CSS_NOT_FOUND")
    result = apply_patch(root, css_path.read_bytes(), arguments.version)
    print(json.dumps(result, sort_keys=True))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except PatchError as error:
        print(f"litellm-dark-mode docker patch [{error.code}]: {error}", file=os.sys.stderr)
        raise SystemExit(1) from error
