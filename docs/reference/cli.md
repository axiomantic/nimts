# CLI Reference

The `nimts` package includes a command-line utility for standalone compilation and module inspection.

---

## Global Usage

```bash
nimts [command] [options]
```

---

## Commands

### `compile`
Compiles a Nim source file into a standalone `.wasm` binary and emits TypeScript glue files.

```bash
nimts compile <input.nim> [output.wasm]
```

**Example:**
```bash
nimts compile src/dsp_engine.nim dist/dsp_engine.wasm
```

### `version`
Displays the current NimTS version.

```bash
nimts --version
# or
nimts -v
```

### `help`
Displays command-line usage information.

```bash
nimts --help
# or
nimts -h
```
