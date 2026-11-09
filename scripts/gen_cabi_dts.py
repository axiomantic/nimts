#!/usr/bin/env python3
"""Generate TypeScript WebAssembly (.d.ts) C-ABI declarations for NimTS modules via HeaderKit."""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import subprocess
import sys
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path
from typing import Any

import headerkit
from headerkit._config import HeaderkitConfig, load_config
from headerkit.backends.nim import NimBackend, _run_nim_ast_helper, clean_nim_c_unit
from headerkit.hooks import Priority, hook
from headerkit.ir import Header, SourceUnit

REPO_ROOT = Path(__file__).resolve().parent.parent


@hook("parse_unit", backend="nim", priority=Priority.PROJECT)
def _parse_nim_wasm_cabi_unit(
    code: str,
    filename: str = "cabi.h",
    include_dirs: list[str] | None = None,
    extra_args: list[str] | None = None,
    **kwargs: Any,
) -> SourceUnit:
    """Parse cross-target wasm32 Nim C-ABI headers via NimBackend(c_backend='tree-sitter')."""
    kwargs.pop("context", None)
    return NimBackend(c_backend="tree-sitter").parse(
        code,
        filename,
        include_dirs=include_dirs,
        extra_args=extra_args,
        **kwargs,
    )


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


@dataclass(frozen=True)
class _NimAstEnrichmentStep:
    """Pipeline transform adapter invoking ``clean_nim_c_unit`` for Nim AST / jsondoc enrichment."""

    nim_source_path: Path | None = None
    jsondoc_entries: Sequence[Mapping[str, Any]] | None = None

    def transform(self, unit: SourceUnit) -> Header:
        cleaned = clean_nim_c_unit(
            unit,
            nim_source_path=self.nim_source_path,
            jsondoc_entries=self.jsondoc_entries,
        )
        if isinstance(cleaned, Header):
            return cleaned
        return Header(
            path=cleaned.path,
            declarations=list(cleaned.declarations),
            included_headers=set(getattr(cleaned, "included_headers", set())),
        )


def derive_interface_name(stem: str) -> str:
    """Derive a PascalCase WebAssembly.Exports interface name from a module stem."""
    cleaned = stem.strip()
    if not cleaned or cleaned.lower() == "nimts":
        return "NimTsCabiExports"
    parts = "".join(ch if ch.isalnum() else " " for ch in cleaned).split()
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


def _extract_exportts_module_from_line(line: str) -> str | None:
    """Extract the module argument from an ``{.exportts(module = "...").}`` pragma line."""
    lower = line.lower()
    idx = lower.find("exportts")
    if idx < 0:
        return None
    rest = line[idx + len("exportts") :].lstrip()
    if not rest.startswith("("):
        return None
    close_paren = rest.find(")")
    if close_paren < 0:
        return None
    inner = rest[1:close_paren]
    first_quote = inner.find('"')
    if first_quote < 0:
        return None
    second_quote = inner.find('"', first_quote + 1)
    if second_quote < 0:
        return None
    mod = inner[first_quote + 1 : second_quote].strip()
    return mod or None


def extract_exportts_companion_entries(nim_source: Path | str) -> list[dict[str, Any]]:
    """Extract companion ``nimts_<name>`` jsondoc enrichment entries for ``{.exportts.}`` procs."""
    src_path = Path(nim_source)
    if not src_path.is_file():
        return []

    ast_data = _run_nim_ast_helper(src_path)
    if ast_data is None:
        return []

    try:
        raw_lines = src_path.read_text(encoding="utf-8").splitlines()
    except OSError:
        raw_lines = []

    entries: list[dict[str, Any]] = []
    for item in ast_data.get("declarations", []):
        if not isinstance(item, Mapping) or item.get("kind") != "routine":
            continue
        nim_name = str(item.get("name") or "").strip()
        if not nim_name:
            continue
        doc_raw = item.get("doc")
        doc = str(doc_raw).strip() if isinstance(doc_raw, str) and doc_raw.strip() else ""
        is_dep = bool(item.get("is_deprecated", False))
        if not doc and not is_dep:
            continue

        line_no = item.get("line")
        mod_prefix: str | None = None
        if isinstance(line_no, int) and 1 <= line_no <= len(raw_lines):
            mod_prefix = _extract_exportts_module_from_line(raw_lines[line_no - 1])

        cabi_name = (
            f"nimts_{mod_prefix}_{nim_name}"
            if mod_prefix
            else f"nimts_{nim_name}"
        )
        entry: dict[str, Any] = {
            "name": nim_name,
            "exportc": cabi_name,
            "type": "skProc",
            "deprecated": is_dep,
        }
        if doc:
            entry["description"] = doc
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
    """Run the HeaderKit ``NimBackend`` + ``clean_nim_c_unit`` + ``TsWasmWriter`` pipeline."""
    root = Path(project_root).resolve() if project_root is not None else REPO_ROOT
    hk_cfg = load_nimts_headerkit_config(root)
    ts_wasm_opts = hk_cfg.writer_options.get("ts_wasm")
    cfg_opts = ts_wasm_opts.options if ts_wasm_opts is not None else {}

    eff_backend = backend_name or hk_cfg.backend or "nim"
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
    transforms_list: list[Any] = []

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
        transforms_list.append(_NimAstEnrichmentStep(nim_source_path=src))

    companion_entries: list[Mapping[str, Any]] = []
    if resolved_nim_source is not None:
        companion_entries.extend(extract_exportts_companion_entries(resolved_nim_source))
    if entries is not None:
        companion_entries.extend(entries)
    if companion_entries:
        transforms_list.append(_NimAstEnrichmentStep(jsondoc_entries=companion_entries))

    for cfg_transform in hk_cfg.transforms or []:
        transforms_list.append(cfg_transform)

    return headerkit.generate(
        header_name,
        "ts_wasm",
        code=header_code,
        backend_name=eff_backend,
        transforms=transforms_list,
        writer_options={
            "interface_name": eff_interface_name,
            "include_memory": eff_include_memory,
        },
        no_cache=True,
    )


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
