#!/usr/bin/env python3
"""Generate TypeScript WebAssembly (.d.ts) C-ABI declarations for NimTS modules via HeaderKit."""

from __future__ import annotations

import argparse
import re
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

from headerkit._config import HeaderkitConfig, load_config
from headerkit.backends import get_backend
from headerkit.transforms.nim_cleanup import NimCleanupTransform
from headerkit.transforms.nim_jsondoc import NimJsonDocEnricher, _parse_nim_source_file
from headerkit.writers import get_writer

REPO_ROOT = Path(__file__).resolve().parent.parent


def load_nimts_headerkit_config(project_root: Path | str | None = None) -> HeaderkitConfig:
    """Load ``headerkit.toml`` from *project_root* when present."""
    root = Path(project_root).resolve() if project_root is not None else REPO_ROOT
    cfg_path = root / "headerkit.toml"
    if cfg_path.is_file():
        return load_config(cfg_path)
    return HeaderkitConfig()
CORE_NIMTS_SOURCES: tuple[Path, ...] = (
    REPO_ROOT / "src" / "nimts" / "memory.nim",
    REPO_ROOT / "src" / "nimts" / "async_bridge.nim",
    REPO_ROOT / "src" / "nimts" / "channels.nim",
)

_PROC_DECL_RE = re.compile(
    r"^\s*(?:proc|func)\s+`?([A-Za-z_][A-Za-z0-9_]*)`?\s*\*?",
)
_EXPORTTS_MODULE_RE = re.compile(
    r"""export[tT]s\s*\(\s*(?:module\s*[:=]\s*)?"([^"]+)"\s*\)""",
)


def derive_interface_name(stem: str) -> str:
    """Derive a PascalCase WebAssembly.Exports interface name from a module stem."""
    cleaned = stem.strip()
    if not cleaned or cleaned.lower() == "nimts":
        return "NimTsCabiExports"
    parts = [p for p in re.split(r"[^A-Za-z0-9]+", cleaned) if p]
    pascal = "".join(p[:1].upper() + p[1:] for p in parts)
    if not pascal:
        return "NimTsCabiExports"
    if pascal[0].isdigit():
        pascal = f"Mod{pascal}"
    return f"{pascal}CabiExports"


def compile_nim_cabi_header(
    nim_source: Path | str,
    *,
    project_root: Path | str | None = None,
) -> str:
    """Compile a Nim module to C-only in a temporary nimcache and return ``cabi.h``."""
    src_path = Path(nim_source)
    if not src_path.is_file():
        raise FileNotFoundError(f"Nim source file not found: {src_path}")

    root = Path(project_root).resolve() if project_root is not None else REPO_ROOT
    src_dir = root / "src"

    with tempfile.TemporaryDirectory(prefix="nimts_cabi_") as tmp_dir:
        cmd = [
            "nim",
            "c",
            "-c",
            "-d:emscripten",
            "-d:useMalloc",
            "-d:release",
            "--opt:speed",
            "--cpu:wasm32",
            "--noMain:on",
            f"-p:{src_dir}",
            f"--nimcache:{tmp_dir}",
            "--header:cabi.h",
            str(src_path.resolve()),
        ]
        proc = subprocess.run(
            cmd,
            cwd=str(root),
            capture_output=True,
            text=True,
            check=False,
        )
        header_file = Path(tmp_dir) / "cabi.h"
        if proc.returncode != 0 or not header_file.is_file():
            stderr = proc.stderr.strip() or proc.stdout.strip()
            raise RuntimeError(f"Failed to generate cabi.h from {src_path}: {stderr}")
        return header_file.read_text(encoding="utf-8")


def extract_exportts_companion_entries(nim_source: Path | str) -> list[dict[str, Any]]:
    """Extract companion ``nimts_<name>`` jsondoc enrichment entries for ``{.exportts.}`` procs."""
    src_path = Path(nim_source)
    if not src_path.is_file():
        return []

    funcs, _, _ = _parse_nim_source_file(src_path)
    try:
        raw_lines = src_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        return []

    module_by_proc: dict[str, str] = {}
    for line in raw_lines:
        m_proc = _PROC_DECL_RE.match(line)
        if not m_proc:
            continue
        p_name = m_proc.group(1)
        m_mod = _EXPORTTS_MODULE_RE.search(line)
        if m_mod:
            module_by_proc[p_name] = m_mod.group(1)

    entries: list[dict[str, Any]] = []
    for fn_meta in funcs:
        if not fn_meta.doc and not fn_meta.is_deprecated:
            continue
        mod_prefix = module_by_proc.get(fn_meta.nim_name)
        cabi_name = (
            f"nimts_{mod_prefix}_{fn_meta.nim_name}"
            if mod_prefix
            else f"nimts_{fn_meta.nim_name}"
        )
        entry: dict[str, Any] = {
            "name": fn_meta.nim_name,
            "exportc": cabi_name,
            "type": "skProc",
            "deprecated": fn_meta.is_deprecated,
        }
        if fn_meta.doc:
            entry["description"] = fn_meta.doc
        entries.append(entry)
    return entries


def generate_cabi_dts(
    *,
    header_code: str | None = None,
    header_path: Path | str | None = None,
    nim_source: Path | str | None = None,
    extra_nim_sources: Sequence[Path | str] | None = None,
    entries: Sequence[Mapping[str, Any]] | None = None,
    interface_name: str | None = None,
    include_memory: bool | None = None,
    project_root: Path | str | None = None,
    include_core_sources: bool = True,
    backend_name: str | None = None,
) -> str:
    """Run the HeaderKit ``NimCleanupTransform`` + ``NimJsonDocEnricher`` + ``TsWasmWriter`` pipeline."""
    root = Path(project_root).resolve() if project_root is not None else REPO_ROOT
    hk_cfg = load_nimts_headerkit_config(root)
    ts_wasm_opts = hk_cfg.writer_options.get("ts_wasm")
    cfg_opts = ts_wasm_opts.options if ts_wasm_opts is not None else {}

    eff_backend = backend_name or hk_cfg.backend or "tree-sitter"
    eff_interface_name = (
        interface_name
        if interface_name is not None
        else str(cfg_opts.get("interface_name", "NimTsCabiExports"))
    )
    eff_include_memory = (
        include_memory
        if include_memory is not None
        else bool(cfg_opts.get("include_memory", True))
    )

    resolved_header_path: Path | None = None
    if header_path is not None:
        resolved_header_path = Path(header_path)
        if not resolved_header_path.is_file():
            raise FileNotFoundError(f"Header file not found: {resolved_header_path}")

    resolved_nim_source: Path | None = None
    if nim_source is not None:
        resolved_nim_source = Path(nim_source)
        if not resolved_nim_source.is_file():
            raise FileNotFoundError(f"Nim source file not found: {resolved_nim_source}")

    if header_code is None:
        if resolved_header_path is not None:
            header_code = resolved_header_path.read_text(encoding="utf-8")
        elif resolved_nim_source is not None:
            header_code = compile_nim_cabi_header(resolved_nim_source, project_root=root)
        else:
            raise ValueError("One of header_code, header_path, or nim_source must be provided.")

    header_name = resolved_header_path.name if resolved_header_path is not None else "cabi.h"
    backend = get_backend(eff_backend)
    if not hk_cfg.transforms or "nim_cleanup" in hk_cfg.transforms:
        cleanup = NimCleanupTransform()
        inc, args, b_opts = cleanup.prepare_parse(header_code, header_name, [], [])
        unit = backend.parse(header_code, header_name, include_dirs=inc, extra_args=args, **b_opts)
        unit = cleanup.transform(unit)
    else:
        unit = backend.parse(header_code, header_name)

    nim_sources_to_enrich: list[Path] = []
    if include_core_sources:
        for core_src in CORE_NIMTS_SOURCES:
            if core_src.is_file():
                nim_sources_to_enrich.append(core_src)
    if resolved_nim_source is not None and resolved_nim_source not in nim_sources_to_enrich:
        nim_sources_to_enrich.append(resolved_nim_source)
    if extra_nim_sources is not None:
        for extra in extra_nim_sources:
            p = Path(extra)
            if not p.is_file():
                raise FileNotFoundError(f"Extra Nim source file not found: {p}")
            if p not in nim_sources_to_enrich:
                nim_sources_to_enrich.append(p)

    for src in nim_sources_to_enrich:
        enricher = NimJsonDocEnricher(nim_source_path=src, project_root=root)
        unit = enricher.transform(unit)

    companion_entries: list[Mapping[str, Any]] = []
    if resolved_nim_source is not None:
        companion_entries.extend(extract_exportts_companion_entries(resolved_nim_source))
    if entries is not None:
        companion_entries.extend(entries)
    if companion_entries:
        unit = NimJsonDocEnricher(entries=companion_entries, project_root=root).transform(unit)

    writer = get_writer(
        "ts_wasm",
        interface_name=eff_interface_name,
        include_memory=eff_include_memory,
    )
    return writer.write(unit)


def generate_default_targets(project_root: Path | None = None) -> tuple[Path, Path]:
    """Regenerate ``ts/cabi_exports.ts`` and ``tests/fixtures/test_module.cabi.d.ts``."""
    root = project_root.resolve() if project_root is not None else REPO_ROOT

    core_dts = generate_cabi_dts(
        nim_source=root / "src" / "nimts.nim",
        interface_name="NimTsCabiExports",
        include_memory=True,
        project_root=root,
    )
    core_out = root / "ts" / "cabi_exports.ts"
    core_out.write_text(core_dts, encoding="utf-8")

    fixture_nim = root / "tests" / "fixtures" / "test_module.nim"
    fixture_header = root / "tests" / "fixtures" / "nimcache" / "cabi.h"
    fixture_dts = generate_cabi_dts(
        header_path=fixture_header if fixture_header.is_file() else None,
        nim_source=fixture_nim,
        interface_name="TestModuleCabiExports",
        include_memory=True,
        project_root=root,
    )
    fixture_out = root / "tests" / "fixtures" / "test_module.cabi.d.ts"
    fixture_out.write_text(fixture_dts, encoding="utf-8")

    return core_out, fixture_out


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Generate TypeScript WebAssembly (.d.ts) declarations from Nim C-ABI headers via HeaderKit."
    )
    parser.add_argument("--header", type=Path, help="Path to generated Nim C-ABI header (cabi.h)")
    parser.add_argument("--nim-source", type=Path, help="Path to source .nim module")
    parser.add_argument("--output", "-o", type=Path, help="Output .d.ts / .ts file path")
    parser.add_argument(
        "--interface-name",
        type=str,
        default=None,
        help="Exported WebAssembly.Exports interface name",
    )
    parser.add_argument(
        "--no-memory",
        action="store_true",
        help="Omit readonly memory: WebAssembly.Memory from the interface",
    )
    parser.add_argument(
        "--default-targets",
        action="store_true",
        help="Regenerate ts/cabi_exports.ts and tests/fixtures/test_module.cabi.d.ts",
    )
    args = parser.parse_args(argv)

    if args.default_targets:
        core_out, fixture_out = generate_default_targets(REPO_ROOT)
        print(f"Generated {core_out.relative_to(REPO_ROOT)} and {fixture_out.relative_to(REPO_ROOT)}")
        return 0

    if args.header is None and args.nim_source is None:
        parser.error("Provide --header, --nim-source, or --default-targets")

    iface_name = args.interface_name
    if not iface_name:
        stem = args.nim_source.stem if args.nim_source is not None else args.header.stem
        iface_name = derive_interface_name(stem)

    dts = generate_cabi_dts(
        header_path=args.header,
        nim_source=args.nim_source,
        interface_name=iface_name,
        include_memory=not args.no_memory,
    )
    if args.output is not None:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(dts, encoding="utf-8")
    else:
        sys.stdout.write(dts)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
