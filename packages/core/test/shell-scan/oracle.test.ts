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
  // Dash runs `scan_probe[x y]=1` as the command `scan_probe[x`.
  fs.copyFileSync(probe, path.join(binDir, "scan_probe[x"))
  // Zsh treats a trailing parenthesized group after an existing file name as glob qualifiers.
  fs.writeFileSync(path.join(tempDir, "a="), "")
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
  "export X=\"$( (( echo '\"' ); scan_probe; ( echo '\"' )) )\"",
  "export X=${unset:+${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "set=1; export X=${set:-${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "export X=\"$(export Y=${unset:+${x['0\"0']}}; scan_probe; : '\"]}}' # '\n)\"",

  // Finding 7: $$ followed by '
  "export X=$$'\\'; scan_probe # '",
  "export X=$$$$'\\'; scan_probe # '",
  "export X=\"$(export Y=$$'\\'; scan_probe # '\n)\"",

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
  "export X=${#}# ; scan_probe",
  "export X=$#a# ; scan_probe",
  "export X=~+# ; scan_probe",
  "{ export X=1; }# ; scan_probe; }",
  "if true; then export X=1; fi# ; scan_probe; fi",
  "for i in 1; do export X=1; done# ; scan_probe; done",
  "case esac# in x) export X=1;; esac#) scan_probe;; esac",
  ": <<A <<B\nA\n$(scan_probe)\nB",
  'export X="$(cat <<EOF\n)\nEOF\nscan_probe)"',
  "cat <<EOF | scan_probe\nhello\nEOF",
  "cat <<EOF && scan_probe\nhello\nEOF",
  "cat <<'E'\"O\"F\n# $(scan_probe)\nEOF\nscan_probe",
  "cat <<E\\\nOF\n$(scan_probe)\nEOF",
  "cat <<-EOF\n\t EOF\n$(scan_probe)\n\tEOF",
  "cat <<export\nex\\\nport\n# $(scan_probe)\nexport",
  "cat <<< 'a'\"$(scan_probe)\"",
  'export X=${x:-"}"}; scan_probe',
  "export X=${x:-'}'}; scan_probe",
  'export X="${x:-"}"}"; scan_probe',
  'export X="${x:-"$(scan_probe)"}"',
  "export X=${x//\\}/}; scan_probe; : }",
  'export X="${x//\\}/}"; scan_probe; : "}"',
  "export X=${x#${y}}; scan_probe",
  'export X="${x#${y:-"}"}}"; scan_probe',
  "export X=${!prefix*}; scan_probe",
  "export X=${x@Q}; scan_probe",
  "export X=\"${unset:+${x['\"']}}\"; scan_probe; : '\"}]}'",
  'export X="${unset:+${x[\'}}\"; scan_probe; : \"\']}}"',
  'echo $(case x in x) echo ")" ;; esac; scan_probe)',
  "echo \"$(case x in (x) echo ')' ;; esac; scan_probe)\"",
  'echo "`echo \\"$(scan_probe)\\"`"',
  "echo `echo \\`scan_probe\\``",
  "echo $( (echo a); scan_probe )",
  "echo $((echo a); scan_probe)",
  "if true; then scan_probe; elif true; then :; else :; fi",
  "for i in in do done esac; do scan_probe; done",
  "for do in 1; do scan_probe; done",
  "for in in 1; do scan_probe; done",
  "for x\nin 1; do scan_probe; done",
  "set -- 1; for x\ndo scan_probe; done",
  "case in in in) scan_probe;; esac",
  "case esac in a|esac) scan_probe;; esac",
  "case y in x) ;; y) scan_probe;; esac",
  "case x in x) scan_probe ;& y) : ;;& z) : ;; esac",
  "case x in x) scan_probe ;| y) : ;; esac",
  "while false; do :; done & scan_probe",
  "{ scan_probe & }",
  "( scan_probe & )",
  "[[ b =~ b ]] && scan_probe",
  "[[ ( a == a ) && ( b == b ) ]] && scan_probe",
  '[[ "$(scan_probe)" == "]]" ]]',
  "(( 1 + $(scan_probe) ))",
  "(( a = 1 )) && scan_probe",
  "(( (1) + (2) )); scan_probe",
  "(( (echo a); scan_probe ))",
  ">/dev/null scan_probe",
  "2>&1 scan_probe",
  "A=1 >/dev/null B=2 scan_probe",
  'export A=1 B="$(scan_probe)"',
  'declare -a arr=(1 "$(scan_probe)")',
  "export X=$'a'\\\n; scan_probe",
  "case x in \\\nx) \\\nscan_probe;; \\\nesac",
  "if true; then \\\nscan_probe; fi",
  '() { :; } "$(scan_probe)"',
  "function f() ( scan_probe ); f",
  "{ export X=1 } && scan_probe",
  "{ export X=1 } ; scan_probe ; }",
  "a[b; scan_probe; echo ]=1",
  "a[0 #]\n]=1; scan_probe",
  "if true; then >/dev/null fi; scan_probe; fi",
  "declare \"${ echo a; }\"'[$(scan_probe)]=1'",
  "n=a; declare \"$n\"'[$(scan_probe)]=1'",
  "declare \"$(echo a)\"'[$(scan_probe)]=1'",
  "if true; then >/dev/null fi; scan_probe",
  "case x in x) >/dev/null esac; scan_probe; esac",
  "echo *(e:'scan_probe q1':)",
  "echo *(+scan_probe)",
  "a=(*(e:'scan_probe g':))",
  "for f in *(e:'scan_probe h':); do :; done",
  "echo ${x:-target(e:'scan_probe p2':)}",
  "echo a=(e:'scan_probe p3':)",
  "echo >*(e:'scan_probe f':)",
  "cat <*(e:'scan_probe g':)",
  "echo $x*(e:'scan_probe h':)",
  "echo \"\"*(e:'scan_probe i':)",
  "echo ${x:-*(e:'scan_probe j':)}",
  "echo {a,*(e:'scan_probe m':)}",
  "declare -a a=(*(e:'scan_probe g':))",
  "export a=(*(e:'scan_probe h':))",
  "printf '%s' @(one|$(scan_probe))",
  "declare -i x='a[$(scan_probe)]'",
  "declare 'a[$(scan_probe)]=1'",
  "a=(1); unset 'a[$(scan_probe)]'",
  "[[ 'a[$(scan_probe)]' -eq 1 ]]",
  "[[ -v 'a[$(scan_probe)]' ]]",
  "read 'a[$(scan_probe)]' </dev/null",
  "printf -v 'a[$(scan_probe)]' x",
  "x='a[$(scan_probe)]'; echo $((x))",
  "x='$(scan_probe)'; echo ${x@P}",
  "x='$(scan_probe)'; echo ${(e)x}",
  "s=abc; x='a[$(scan_probe)0]'; printf '%s' \"${s:x}\"",
  "ref='x[$(scan_probe)0]'; printf '%s' \"${!ref}\"",
  "declare ${x:-'a[$(scan_probe)]=1'}",
  'declare "${x:-a[\\$(scan_probe)]=1}"',
  "read ${x:-'a[$(scan_probe)]'} </dev/null",
  'a=(1); unset "a[\\$(scan_probe)]"',
  "declare \"$(echo 'a[$(scan_probe)]=1')\"",
  "declare -a 'a=([$(scan_probe)]=1)'",
  "x='$(scan_probe)'; echo \"${x@P}\"",
  "x='$(scan_probe)'; echo ${(ee)x}",
  "echo ${(e):-'$(scan_probe)'}",
  "x='*(e:scan_probe:)'; echo ${~x}",
  "x='*(e:scan_probe:)'; echo $~x",
  "true &>/dev/null scan_probe",
  "true &>>/dev/null scan_probe",
  "cat <<\\\n-EOF\nEOF\nscan_probe h1\n-EOF",
  "scan_probe[x y]=1",
  "cat <<\\\n-EOF\n-EOF\nscan_probe z\nEOF",
  "true &\\\n>/dev/null scan_probe",
  "a[x '$(scan_probe)']=1",
  "a[1 + $(scan_probe)]=1",
  "case [ in [) scan_probe & ( scan_probe q ]) ;; esac",
  "case x in (x|[) scan_probe & ( scan_probe q ]) ;; esac",
  "echo \"${x:-$'$(scan_probe q1)'}\"",
  "cat <<E\n$\\\n(scan_probe h)\nE",
  "echo ${x:-$\\\n(scan_probe p)}",
  "(( $\\\n(scan_probe a) ))",
  "[[ $\\\n(scan_probe c) ]]",
  "a=($\\\n(scan_probe arr))",
  "[[ -n <\\\n(scan_probe c1) ]]",
  "a=(<\\\n(scan_probe a1))",
  "echo @(<(scan_probe e1))",
  "echo ${x:-<(scan_probe p1)}",
  "x=${y:-<(scan_probe p4)}",
  "[[ x == ${y:-<(scan_probe p5)} ]]",
  "echo $(( $'$(scan_probe a)' ))",
  "(( x = $'$(scan_probe b)' ))",
  "echo $(( ${x:-'$(scan_probe a)'} ))",
  "(( ${x:-'$(scan_probe b)'} ))",
  "a[${x:-'$(scan_probe c)'}]=1",
  "echo $[ ${x:-'$(scan_probe d)'} ]",
  "echo ${a[${x:-'$(scan_probe e)'}]}",
  "echo \"${a[${x:-'$(scan_probe f)'}]}\"",
  "cat <<E\n${x:-'$(scan_probe h)'}\nE",
  "echo ${x:->(scan_probe g)}",
  "echo $[ $'$(scan_probe h)' ]",
  "cat <\\\n(scan_probe i)",
] as const

const knownGapFixtures = [] as const

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

describe.skipIf(process.platform === "win32")("real-shell soundness oracle", () => {
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

  for (const fixture of knownGapFixtures) {
    test.failing(`known gap: ${JSON.stringify(fixture)}`, () => {
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

describe.skipIf(process.platform === "win32")("real-shell directory oracle", () => {
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
    ['echo "$(case x in @(a)) echo hi;; esac)"', ["echo", "echo"]],
  ] as const)("scans valid construct: %s", (source, expectedHeads) => {
    const result = ShellScan.scan(source)
    expect(result.kind).toBe("scanned")
    if (result.kind !== "scanned") return
    expect(result.commands.map((cmd) => cmd.words[0])).toEqual([...expectedHeads])
  })

  test("scans POSIX for loops without an in list", () => {
    const result = ShellScan.scan("set -- 1; for x do scan_probe; done")
    expect(result.kind).toBe("scanned")
  })

  test("keeps incomplete pipeline inside case arm opaque", () => {
    expect(ShellScan.scan("case $r in a) ls |;; esac").kind).toBe("opaque")
  })
})
