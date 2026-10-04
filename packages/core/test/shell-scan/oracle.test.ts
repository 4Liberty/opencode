import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "fs"
import os from "os"
import path from "path"
import { ShellParse } from "../../src/shell/parse.js"
import { ShellScan } from "../../src/shell/scan.js"

const shellCandidates = ["/bin/bash", "/opt/homebrew/bin/bash", "/usr/local/bin/bash", "bash", "zsh", "dash"]
const shells = [
  ...new Set(
    shellCandidates
      .map((item) => (item.startsWith("/") ? (fs.existsSync(item) ? item : undefined) : Bun.which(item)))
      .filter((item): item is string => Boolean(item)),
  ),
]

function shellFlags(executable: string) {
  if (executable.endsWith("/bash")) return ["--noprofile", "--norc"]
  if (executable.endsWith("/zsh")) return ["-f"]
  return []
}

let tempDir = ""
let binDir = ""
let targetDir = ""
let targetRealDir = ""

beforeAll(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shell-oracle-"))
  binDir = path.join(tempDir, "bin")
  targetDir = path.join(tempDir, "target")
  fs.mkdirSync(binDir, { recursive: true })
  fs.mkdirSync(targetDir, { recursive: true })
  targetRealDir = fs.realpathSync(targetDir)
  const probe = path.join(binDir, "scan_probe")
  fs.writeFileSync(probe, '#!/bin/sh\nprintf \'%s\\n\' "scan_probe${1:+ $*}" >> "$SCAN_PROBE_LOG"\n')
  fs.chmodSync(probe, 0o755)
})

afterAll(() => {
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
})

function runProbeOracle(source: string) {
  let executedInAnyShell = false
  const scanResult = ShellScan.scan(source)

  for (const executable of shells) {
    const logFile = path.join(tempDir, `probe-${Math.random().toString(36).slice(2)}.log`)
    fs.writeFileSync(logFile, "")
    Bun.spawnSync([executable, ...shellFlags(executable), "-c", source], {
      cwd: tempDir,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: tempDir,
        LC_ALL: "C",
        SCAN_PROBE_LOG: logFile,
      },
      timeout: 2_000,
    })
    const observed = fs
      .readFileSync(logFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
    fs.rmSync(logFile, { force: true })
    if (observed.length === 0) continue
    executedInAnyShell = true

    if (scanResult.kind === "opaque") continue
    const reported = scanResult.commands.filter((cmd) => !cmd.declaration).map((cmd) => cmd.words.join(" "))
    for (const invocation of observed) {
      expect(reported, `${executable} executed ${invocation} in: ${source}`).toContain(invocation)
    }
  }

  expect(executedInAnyShell, `Fixture never executed scan_probe in any real shell: ${source}`).toBe(true)
}

async function runDirectoryOracle(buildSource: (target: string) => string) {
  const source = buildSource(targetDir)
  let changedInAnyShell = false

  for (const executable of shells) {
    const pwdFile = path.join(tempDir, `pwd-${Math.random().toString(36).slice(2)}.log`)
    fs.writeFileSync(pwdFile, "")
    Bun.spawnSync([executable, ...shellFlags(executable), "-c", `${source}\npwd > "$SCAN_PWD_LOG"`], {
      cwd: tempDir,
      env: {
        PATH: `${binDir}:/usr/bin:/bin`,
        HOME: tempDir,
        LC_ALL: "C",
        SCAN_PWD_LOG: pwdFile,
      },
      timeout: 2_000,
    })
    const finalPwd = fs.readFileSync(pwdFile, "utf8").trim()
    fs.rmSync(pwdFile, { force: true })
    if (finalPwd !== targetDir && finalPwd !== targetRealDir) continue
    changedInAnyShell = true

    const parsed = await Effect.runPromiseExit(ShellParse.scanPortable(source, executable, tempDir))
    if (Exit.isFailure(parsed)) continue
    expect(parsed.value.directories, `${executable} changed directory in: ${source}`).toContain(targetDir)
  }

  expect(changedInAnyShell, `Fixture never changed directory in any real shell: ${source}`).toBe(true)
}

const underReportFixtures = [
  // Finding 1: ]] inside a word inside [[ ... ]]
  "[[ a]]# ]] && scan_probe",
  'export X="$([[ a]]# ]] && scan_probe\n)"',

  // Finding 2: non-reserved } inside { ... }
  "{ export X={}# ; scan_probe; }",
  '{ export X="a"{}# ; scan_probe; }',
  "{ { export X={}# ; scan_probe; }\n}",
  'export X="$({ export Y={}# ; scan_probe; }\n)"',
  'export X="`{ export Y={}# ; scan_probe; }`"',

  // Finding 3: subscript lookahead spanning ; or newline
  "unset a[b; scan_probe; echo ]=1",
  "unset a[b\nscan_probe\necho ]+=1",
  "export a[b; scan_probe; echo ]=1",
  'export X="$(unset a[b; scan_probe; echo ]=1)"',

  // Finding 4: esac pattern word after ( or | in case
  'export X="$(case esac in (esac) scan_probe;; esac)"',

  // Finding 5: brace-body for loop
  "for i in 1; { if true; then scan_probe; fi }; while false; do export X=1; done",
  'export X="$(for i in 1; { if true; then scan_probe; fi }; while false; do export Y=1; done)"',

  // Finding 6: (( ... )) subshell vs arithmetic and subscript single quotes
  "(( echo '\"' ); scan_probe; ( echo '\"' ))",
  "((( echo '\"' ); scan_probe; ( echo '\"' )))",
  'export X="$( (( echo \'\"\' ); scan_probe; ( echo \'\"\' )) )"',
  "export X=${unset:+${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "set=1; export X=${set:-${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  'export X="$(export Y=${unset:+${x[\'0"0\']}}; scan_probe; : \'"]}}\' # \'\n)"',

  // Finding 7: $$ followed by '
  "export X=$$'\\'; scan_probe # '",
  "export X=$$$$'\\'; scan_probe # '",
  'export X="$(export Y=$$\'\\\'; scan_probe # \'\n)"',

  // Finding 8: double-quoted backticks unescaping \"
  'export X="`export Y=\\"\'\\" ; scan_probe; export Z=\\"\'\\"`"',
  '{ export X="`export Y=\\"\'\\" ; scan_probe; export Z=\\"\'\\"`"; }',

  // Finding 9: <<- heredoc tab stripping only at logical line start
  ": <<-export\n\tex\\\n\tport\n# $(scan_probe)\nexport",
  'export X="$(cat <<-export\n\tex\\\n\tport\n# $(scan_probe)\nexport\n)"',

  // Finding 10: bash 5.3 nofork command substitution with line continuation
  'export X="${\\\n scan_probe; }"',

  // Finding 11: !(...) negated subshell vs extglob
  "!(scan_probe)",
  "!(scan_probe; true)",
  "if !(scan_probe); then :; fi",
  'export X="$(!(scan_probe))"',

  // Finding 12: function names with +/@ and compound bodies
  'export X="$(f+() case x in x) scan_probe;; esac; f+)"',

  // Finding 14: dialect divergences (<<$"..." and $[...])
  ': <<$"export"\n$export\nscan_probe\nexport',
  "export X=$[1; scan_probe; : ]",
  "X=$[1 scan_probe ]",
] as const

const additionalOracleFixtures = [
  "[[ a]]b# ]] && scan_probe",
  '[[ "a]]"# ]] && scan_probe',
  "[[ 'a]]'# ]] && scan_probe",
  "[[ a]]b = a]]b ]] && scan_probe",
  "{ export X=a}# ; scan_probe; }",
  "{ case esac in (esac) scan_probe;; esac\n}",
  'export X="$(case esac in (a|esac) scan_probe;; esac)"',
  "for i in 1; { scan_probe; }; while false; do export X=1; done",
  "for ((i=0; i<1; i++)); { scan_probe; }; while false; do export X=1; done",
  "for i in 1; scan_probe",
  'export X="`echo \\"(\\"; scan_probe; echo \\")\\"`"',
  ": <<-export\n\tex\\\n\tport\n$(scan_probe)\nexport",
  'export X="${\n scan_probe; }"',
  'export X="${|\\\n REPLY=$(scan_probe); }"',
  "f+() { scan_probe; }; f+",
  "f@g() case x in x) scan_probe;; esac; f@g",
  'export X="$(f@g() case x in x) scan_probe;; esac; f@g)"',
  'export X="$(f@g() for i in 1; do scan_probe; done; f@g)"',
  ': <<$"export"\nexport\nscan_probe\n$export',
  'export X=$["]"]; scan_probe # ]',
] as const

const nestingWrappers: Array<[name: string, wrap: (inner: string) => string]> = [
  ["$(...)", (inner) => `export OUTER=$( ${inner}\n)`],
  ['"$(...)"', (inner) => `export OUTER="$( ${inner}\n)"`],
  ["backticks", (inner) => `export OUTER=\` ${inner}\n\``],
  ["heredoc", (inner) => `: <<EOF\n$( ${inner}\n)\nEOF`],
  ["case arm", (inner) => `case x in x) ${inner}\n;; esac`],
  ["for loop", (inner) => `for k in 1; do ${inner}\ndone`],
  ["function", (inner) => `wrap_fn() {\n${inner}\n}; wrap_fn`],
]

const nestedCoreFixtures = [
  "[[ a]]# ]] && scan_probe",
  "{ export X={}# ; scan_probe; }",
  "unset a[b; scan_probe; echo ]=1",
  "(( echo '\"' ); scan_probe; ( echo '\"' ))",
  "export X=${unset:+${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "export X=$$'\\'; scan_probe # '",
  "!(scan_probe)",
] as const

describe("real-shell soundness oracle", () => {
  test("discovers at least bash on PATH", () => {
    expect(shells.some((item) => item.endsWith("/bash"))).toBe(true)
  })

  for (const fixture of underReportFixtures) {
    test(`reports or rejects real-shell execution: ${JSON.stringify(fixture)}`, () => {
      runProbeOracle(fixture)
    })
  }

  for (const fixture of additionalOracleFixtures) {
    test(`reports or rejects additional real-shell variant: ${JSON.stringify(fixture)}`, () => {
      runProbeOracle(fixture)
    })
  }

  for (const [wrapperName, wrap] of nestingWrappers) {
    for (const core of nestedCoreFixtures) {
      const fixture = wrap(core)
      test(`reports or rejects in ${wrapperName}: ${JSON.stringify(core)}`, () => {
        runProbeOracle(fixture)
      })
    }
  }
})

describe("real-shell directory oracle", () => {
  test("cd with redirect before target directory", async () => {
    await runDirectoryOracle((target) => `cd >/dev/null ${target}`)
  })

  test("cd with stderr redirect before target directory", async () => {
    await runDirectoryOracle((target) => `cd 2>/dev/null ${target}`)
  })

  test("cd with ANSI-C quoted target directory", async () => {
    await runDirectoryOracle((target) => `cd $'${target}'`)
  })

  test("cd with double-quoted target directory", async () => {
    await runDirectoryOracle((target) => `cd "${target}"`)
  })
})

describe("valid commands that must scan without false opacity", () => {
  test.each([
    ["case $r in a) ls | head;; esac", ["ls", "head"]],
    ["case $r in a) ls && echo;; esac", ["ls", "echo"]],
    ["{ find . -exec echo {} \\; ; }", ["find"]],
    ["{ echo {a,{b,c}}; }", ["echo"]],
    ["if true; then\\\n echo hi; fi", ["true", "echo"]],
    ["for ((i=0; i<2; i++)) do echo hi; done", ["echo"]],
    ["case x in [)] ) echo hi;; esac", ["echo"]],
    ['echo "$(case x in @(a)) echo hi;; esac)"', ["echo", "echo"]],
  ] as const)("scans valid construct: %s", (source, expectedHeads) => {
    const result = ShellScan.scan(source)
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") return
    expect(result.commands.map((cmd) => cmd.words[0])).toEqual([...expectedHeads])
  })

  test("keeps incomplete pipeline inside case arm opaque", () => {
    expect(ShellScan.scan("case $r in a) ls |;; esac").kind).toBe("opaque")
  })

  test("scans deeply nested brace groups with bracket words under 50ms", () => {
    const source = "{ ".repeat(31) + "echo " + "a[] ".repeat(15_000) + "; }".repeat(31)
    const start = performance.now()
    const result = ShellScan.scan(source)
    const elapsed = performance.now() - start
    expect(result.kind).toBe("scanned")
    expect(elapsed).toBeLessThan(50)
  })
})
