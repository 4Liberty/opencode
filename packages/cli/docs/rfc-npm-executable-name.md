# RFC: The `.exe` name of the npm-installed CLI on Unix

Status: Proposed decision record (2026-09-28)

## Problem

A Linux user can run `opencode` and see `opencode.exe` in a process list. That looks like a Windows program, even though the running file is a native Linux ELF executable. The suffix is a pathname chosen by our npm packaging, not the executable format or a compatibility layer.

This RFC records a deliberate *non-change*: why that pathname exists and the cost of changing it. It does not propose changing the binary in this PR.

## How it works today

- The published `@opencode/cli` package has a single `bin` target, `./bin/opencode.exe`, for Linux, macOS, and Windows. The same target also serves the `opencode2` command. See [`script/publish.ts`](../script/publish.ts).
- Each platform-specific package contains a native binary: `opencode` on Linux/macOS and `opencode.exe` on Windows. The generic package's [`postinstall.mjs`](../script/postinstall.mjs) selects the appropriate optional dependency and hard-links or copies its binary to that *same* `bin` target. Therefore, on Unix, a native executable ends up at a pathname ending in `.exe`.
- The direct [install script](../../../install) and release archives keep the Unix executable named `opencode`. This is specific to the generic npm package; the public command users type remains `opencode`.

The constraint is the combination of **one cross-platform npm package, one static `bin` target, and direct execution of the native binary without a launcher**. Windows needs an executable target there, while the generic package cannot select a different `bin` path per OS at install time. Choosing `opencode.exe` lets the Windows target be a real executable and lets npm expose the same command everywhere. Unix permits an ELF or Mach-O file to have that suffix, but process tools can then display it.

The package also ships a text placeholder at the target path until postinstall replaces it. A skipped postinstall is a *separate functional install problem*; removing the misleading Unix suffix alone would not resolve that failure mode.

## Options

1. **Keep the direct native target (recommended for now).** No new process, signal forwarding, runtime dependency at launch, or install-path migration. Cost: Unix process lists can say `opencode.exe`, which is confusing. Explain the packaging trade-off when asked.
2. **Use a platform-aware launcher as the npm `bin` target.** It could select `opencode` on Unix and `opencode.exe` on Windows from the platform-specific package, so the child process has its native filename. Cost: an additional process or platform-specific `exec` behavior, startup work, signal and exit-code forwarding, and a larger test surface across package managers. A launcher already exists for development in [`bin/opencode.cjs`](../bin/opencode.cjs); using one in release packaging would be a deliberate change to today's direct-execution behavior, not a rename.
3. **Publish different top-level packages or mutate package-manager links per OS.** This can give Unix a suffix-free target without a launcher, but loses the simple single-package install or makes startup depend on nonportable install/link behavior. Do not assume rewriting `package.json` in postinstall will reliably relink a previously created command.
4. **Change the displayed process title.** This might cosmetically affect some monitors, but leaves the actual filename and packaging contract unchanged. It is not a fix for the underlying discrepancy.

## Proposal and decision boundary

**Proposed decision: do not add a launcher or rename the npm target just to change the process-list label.** Keep the existing packaging until the name causes enough user confusion to justify a packaging change, or a broader install/reliability redesign makes the launcher cost worthwhile. Treat a skipped-postinstall/broken-upgrade fix on its own merits rather than claiming the filename change fixes it. This RFC is a record for review, not approval or implementation of a launcher.

If we choose an alternative, prove it against the current behavior before release: native binary format and process name on Linux and macOS; `.exe` startup on Windows; npm, Bun, pnpm, and Yarn installs; blocked or skipped install scripts; upgrades; exit codes and signals; and both `opencode` and the legacy `opencode2` command. Keep direct-install and archive filenames unchanged unless there is a separate reason to alter them.
