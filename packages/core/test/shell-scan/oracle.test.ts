import { afterAll, describe, expect, test } from "bun:test"
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

const root = fs.mkdtempSync(path.join(os.tmpdir(), "opencode-shell-oracle-"))
const bin = path.join(root, "bin")
const target = path.join(root, "target")
const log = path.join(root, "log")
fs.mkdirSync(bin)
fs.mkdirSync(target)
fs.writeFileSync(
  path.join(bin, "scan_probe"),
  '#!/bin/sh\nprintf \'%s\\n\' "scan_probe${1:+ $*}" >> "$SCAN_PROBE_LOG"\n',
  {
    mode: 0o755,
  },
)
// Dash runs `scan_probe[x y]=1` as the command `scan_probe[x`.
fs.copyFileSync(path.join(bin, "scan_probe"), path.join(bin, "scan_probe[x"))
// Zsh treats a trailing parenthesized group after an existing file name as glob qualifiers.
fs.writeFileSync(path.join(root, "a="), "")

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

function shellFlags(executable: string) {
  if (executable.endsWith("/bash")) return ["--noprofile", "--norc"]
  if (executable.endsWith("/zsh")) return ["-f"]
  return []
}

// Runs source in a real shell and returns the lines it logged.
function observe(executable: string, source: string) {
  fs.writeFileSync(log, "")
  Bun.spawnSync([executable, ...shellFlags(executable), "-c", source], {
    cwd: root,
    env: { PATH: `${bin}:/usr/bin:/bin`, HOME: root, LC_ALL: "C", SCAN_PROBE_LOG: log },
    timeout: 2_000,
  })
  return fs
    .readFileSync(log, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

// Each dialect must report what its shells run; posix, the default, covers every shell.
const dialects = {
  bash: (executable: string) => path.basename(executable) === "bash",
  zsh: (executable: string) => path.basename(executable) === "zsh",
  posix: () => true,
} satisfies Record<ShellScan.Dialect, (executable: string) => boolean>

function expectProbesReported(source: string) {
  const runs = shells.map((executable) => [executable, observe(executable, source)] as const)
  expect(
    runs.some(([, invocations]) => invocations.length > 0),
    `Fixture never executed scan_probe in any real shell: ${source}`,
  ).toBe(true)
  expect(ShellScan.scan(source)).toEqual(ShellScan.scan(source, "posix"))
  for (const [dialect, runsIn] of Object.entries(dialects)) {
    const result = ShellScan.scan(source, dialect as ShellScan.Dialect)
    if (result.kind === "opaque") continue
    const reported = result.commands.filter((command) => !command.declaration).map((command) => command.words.join(" "))
    for (const [executable, invocations] of runs.filter(([executable]) => runsIn(executable)))
      for (const invocation of invocations)
        expect(reported, `${executable} executed ${invocation} with ${dialect} in: ${source}`).toContain(invocation)
  }
}

// Each fixture runs scan_probe in at least one real shell, which the scanner must report or reject.
const fixtures = [
  'echo "${unset:+${x[\'"\']}}"]}} \'$(scan_probe)\' " # "',
  "echo \"${unset:+${x['}}\"']}}'; scan_probe # \"",
  "echo \"${x:-$'\\''}\"; scan_probe # '\"",
  "cat <<E\n${x:-'}'}' $(scan_probe)\nE",
  'echo "${x:-a\'b}c\'d}"$(scan_probe)"\'"',
  "echo \"${PATH//:/$'\\n'}\"; scan_probe ok",
  "echo $(( : # ))'\n); scan_probe ) # '",
  "echo $(( $(echo 1) # ))'\n); scan_probe ) # '",
  "(( : # ))'\n); scan_probe ) # '",
  "echo $(( 16#ff + 2#1 + $# + ${#x} )); scan_probe ok",
  "(( scan_probe ))",
  "(( (scan_probe) & (scan_probe) ))",
  "(( (scan_probe)\n(scan_probe) ))",
  "cat <<'}'; {\n:\n}\nscan_probe; cat <<'}'; }\n}",
  "cat <<'x)'; case x in\nx)\nx) scan_probe; cat <<'x)'\nx)\n;; esac",
  "cat <<'if'; f()\nif\nif scan_probe; cat <<'if'\nif\ntrue; then :; fi; f",
  "cat <<E; ( true\nE\nscan_probe g\n)",
  "cat <<E; { true\nE\nscan_probe g\n}",
  "cat <<E; f() { true\nE\nscan_probe f\n}; f",
  "cat <<E; if true\nE\nscan_probe i\nthen :; fi",
  "cat <<E; echo $(true\nscan_probe s\n)\nE\nscan_probe after",
  "cat <<E; echo `true\nscan_probe b\n`\nE\nscan_probe after",
  "cat <<E; cat <(true\nscan_probe s\n)\nE\nscan_probe after",
  "cat <<E; x=$(cat <<F\nF\n)\nE\nscan_probe out",
  "{ cat <<E; }\nscan_probe x\nE\nscan_probe y",
  "[[ a]]b# ]] && scan_probe",
  '[[ "a]]"# ]] && scan_probe',
  "[[ 'a]]'# ]] && scan_probe",
  "[[ a]]b = a]]b ]] && scan_probe",
  '{ export X="a"{}# ; scan_probe; }',
  "{ export X=a}# ; scan_probe; }",
  "{ case esac in (esac) scan_probe;; esac\n}",
  "unset a[b\nscan_probe\necho ]+=1",
  "export a[b; scan_probe; echo ]=1",
  "a[b; scan_probe; echo ]=1",
  "a[0 #]\n]=1; scan_probe",
  "for i in 1; { scan_probe; }; while false; do export X=1; done",
  "for ((i=0; i<1; i++)); { scan_probe; }; while false; do export X=1; done",
  "for i in 1; scan_probe",
  "((( echo '\"' ); scan_probe; ( echo '\"' )))",
  "set=1; export X=${set:-${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "export X=$$$$'\\'; scan_probe # '",
  'export X="`export Y=\\"\'\\" ; scan_probe; export Z=\\"\'\\"`"',
  'export X="`echo \\"(\\"; scan_probe; echo \\")\\"`"',
  ": <<-export\n\tex\\\n\tport\n$(scan_probe)\nexport",
  'export X="${\\\n scan_probe; }"',
  'export X="${\n scan_probe; }"',
  'export X="${|\\\n REPLY=$(scan_probe); }"',
  "!(scan_probe; true)",
  "if !(scan_probe); then :; fi",
  "f+() { scan_probe; }; f+",
  ': <<$"export"\n$export\nscan_probe\nexport',
  ': <<$"export"\nexport\nscan_probe\n$export',
  "export X=$[1; scan_probe; : ]",
  "X=$[1 scan_probe ]",
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
  "set -- 1; for x do scan_probe; done",
  "case in in in) scan_probe;; esac",
  "case esac in a|esac) scan_probe;; esac",
  "case y in x) ;; y) scan_probe;; esac",
  "case x in x) scan_probe ;& y) : ;;& z) : ;; esac",
  "case x in x) scan_probe ;| y) : ;; esac",
  "case [ in [) scan_probe & ( scan_probe q ]) ;; esac",
  "case x in (x|[) scan_probe & ( scan_probe q ]) ;; esac",
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

  // Dialects disagree about reserved words after redirects and operators split by line continuations.
  "if true; then >/dev/null fi; scan_probe; fi",
  "if true; then >/dev/null fi; scan_probe",
  "case x in x) >/dev/null esac; scan_probe; esac",
  "true &>/dev/null scan_probe",
  "true &>>/dev/null scan_probe",
  "true &\\\n>/dev/null scan_probe",
  "cat <<\\\n-EOF\nEOF\nscan_probe h1\n-EOF",
  "cat <<\\\n-EOF\n-EOF\nscan_probe z\nEOF",
  "cat <\\\n(scan_probe i)",
  "[[ -n <\\\n(scan_probe c1) ]]",
  "a=(<\\\n(scan_probe a1))",
  "cat <<E\n$\\\n(scan_probe h)\nE",
  "echo ${x:-$\\\n(scan_probe p)}",
  "(( $\\\n(scan_probe a) ))",
  "[[ $\\\n(scan_probe c) ]]",
  "a=($\\\n(scan_probe arr))",

  // Dash splits assignment subscripts at blanks.
  "scan_probe[x y]=1",
  "a[x '$(scan_probe)']=1",
  "a[1 + $(scan_probe)]=1",

  // Expansions inside parameter words, arithmetic, and subscripts.
  "echo \"${x:-$'$(scan_probe q1)'}\"",
  "echo ${x:-<(scan_probe p1)}",
  "echo ${x:->(scan_probe g)}",
  "x=${y:-<(scan_probe p4)}",
  "[[ x == ${y:-<(scan_probe p5)} ]]",
  "echo $(( $'$(scan_probe a)' ))",
  "(( x = $'$(scan_probe b)' ))",
  "echo $(( ${x:-'$(scan_probe a)'} ))",
  "(( ${x:-'$(scan_probe b)'} ))",
  "a[${x:-'$(scan_probe c)'}]=1",
  "echo $[ ${x:-'$(scan_probe d)'} ]",
  "echo $[ $'$(scan_probe h)' ]",
  "echo ${a[${x:-'$(scan_probe e)'}]}",
  "echo \"${a[${x:-'$(scan_probe f)'}]}\"",
  "cat <<E\n${x:-'$(scan_probe h)'}\nE",

  // Zsh glob qualifiers and extglob groups run code in globbed words.
  "echo @(<(scan_probe e1))",
  "printf '%s' @(one|$(scan_probe))",
  "echo *(e:'scan_probe q1':)",
  "echo *(+scan_probe)",
  "a=(*(e:'scan_probe g':))",
  "declare -a a=(*(e:'scan_probe g':))",
  "export a=(*(e:'scan_probe h':))",
  "for f in *(e:'scan_probe h':); do :; done",
  "echo ${x:-target(e:'scan_probe p2':)}",
  "echo ${x:-*(e:'scan_probe j':)}",
  "echo a=(e:'scan_probe p3':)",
  "echo >*(e:'scan_probe f':)",
  "cat <*(e:'scan_probe g':)",
  "echo $x*(e:'scan_probe h':)",
  "echo \"\"*(e:'scan_probe i':)",
  "echo {a,*(e:'scan_probe m':)}",

  // Builtins and arithmetic evaluate subscripts in decoded literal text.
  "declare -i x='a[$(scan_probe)]'",
  "declare 'a[$(scan_probe)]=1'",
  "declare -a 'a=([$(scan_probe)]=1)'",
  "a=(1); unset 'a[$(scan_probe)]'",
  'a=(1); unset "a[\\$(scan_probe)]"',
  "[[ 'a[$(scan_probe)]' -eq 1 ]]",
  "[[ -v 'a[$(scan_probe)]' ]]",
  "read 'a[$(scan_probe)]' </dev/null",
  "printf -v 'a[$(scan_probe)]' x",
  "x='a[$(scan_probe)]'; echo $((x))",
  "s=abc; x='a[$(scan_probe)0]'; printf '%s' \"${s:x}\"",
  "ref='x[$(scan_probe)0]'; printf '%s' \"${!ref}\"",
  "declare ${x:-'a[$(scan_probe)]=1'}",
  'declare "${x:-a[\\$(scan_probe)]=1}"',
  "read ${x:-'a[$(scan_probe)]'} </dev/null",
  "declare \"$(echo 'a[$(scan_probe)]=1')\"",
  "declare \"${ echo a; }\"'[$(scan_probe)]=1'",
  "n=a; declare \"$n\"'[$(scan_probe)]=1'",
  "declare \"$(echo a)\"'[$(scan_probe)]=1'",
  "builtin declare 'a[$(scan_probe)]=1'",
  "printf -v'a[$(scan_probe)]' x",
  "set -- 'a[$(scan_probe)]'; echo $(($1))",
  "for x in 'a[$(scan_probe)]'; do echo $((x)); done",
  "a=(1 'a[$(scan_probe)]'); echo $((a[1]))",
  "x='a[$(scan_probe)]' eval 'echo $((x))'",
  "a=(1); echo $(( a[\\$(scan_probe)] ))",
  "a=(1); (( a[\\$(scan_probe)] ))",

  // Explicit evaluation operators.
  "x='$(scan_probe)'; echo ${x@P}",
  "x='$(scan_probe)'; echo \"${x@P}\"",
  "x='$(scan_probe)'; echo ${(e)x}",
  "x='$(scan_probe)'; echo ${(ee)x}",
  "echo ${(e):-'$(scan_probe)'}",
  "x='*(e:scan_probe:)'; echo ${~x}",
  "x='*(e:scan_probe:)'; echo $~x",
] as const

// These also run inside every wrapper below.
// Confirmed misses awaiting fixes.
const knownGaps = [
  "printf -v x 'a[$(scan_probe)]'; echo $((x))",
  "a=(1); getopts a: x -a 'a[$(scan_probe)]'; echo $((OPTARG))",
  "command -- declare 'a[$(scan_probe)]=1'",
  "a=(1); unset 'a[b[$\\\n(scan_probe)0]]'",
  'declare \'a["\\"]"$(scan_probe)0]=1\'',
  "declare -a 'a=(+ [$(scan_probe)]=1)'",
  "a=(1); echo ${a[b[\\$(scan_probe)]]}",
  'a["b[\\$(scan_probe)]"]=1',
  'b=1; a["b[\\$(scan_probe)1]"]=1',
  "a=(1); echo $[ ${x:-a[\\$(scan_probe)1]} ]",
  "a=(1); s=abc; echo ${s:'a[$(scan_probe)0]'}",
  "a=(1); s=abc; echo ${s:${x:-'a[$(scan_probe)1]'}}",
  "x='*(e:scan_probe:)'; echo $^~x",
  "x='$(scan_probe)'; echo \"${\\\n(e)x}\"",
  "x='$(scan_probe)'; echo ${(j:):e)x}",
] as const

const nestedFixtures = [
  "[[ a]]# ]] && scan_probe",
  "{ export X={}# ; scan_probe; }",
  "unset a[b; scan_probe; echo ]=1",
  "case esac in (esac) scan_probe;; esac",
  "case esac in (a|esac) scan_probe;; esac",
  "for i in 1; { if true; then scan_probe; fi }; while false; do export X=1; done",
  "(( echo '\"' ); scan_probe; ( echo '\"' ))",
  "export X=${unset:+${x['0\"0']}}; scan_probe; : '\"]}}' # '",
  "export X=$$'\\'; scan_probe # '",
  ": <<-export\n\tex\\\n\tport\n# $(scan_probe)\nexport",
  "!(scan_probe)",
  "f+() case x in x) scan_probe;; esac; f+",
  "f@g() case x in x) scan_probe;; esac; f@g",
  "f@g() for i in 1; do scan_probe; done; f@g",
] as const

const wrappers: Array<[name: string, wrap: (inner: string) => string]> = [
  ["$(...)", (inner) => `export OUTER=$( ${inner}\n)`],
  ['"$(...)"', (inner) => `export OUTER="$( ${inner}\n)"`],
  ["backticks", (inner) => `export OUTER=\` ${inner}\n\``],
  ["heredoc", (inner) => `: <<EOF\n$( ${inner}\n)\nEOF`],
  ["case arm", (inner) => `case x in x) ${inner}\n;; esac`],
  ["for loop", (inner) => `for k in 1; do ${inner}\ndone`],
  ["function", (inner) => `wrap_fn() {\n${inner}\n}; wrap_fn`],
  ["brace group", (inner) => `{ ${inner}\n}`],
]

describe.skipIf(process.platform === "win32")("real-shell soundness oracle", () => {
  test("discovers at least bash on PATH", () => {
    expect(shells.some((item) => item.endsWith("/bash"))).toBe(true)
  })

  test.failing.each([...knownGaps])("known gap: %j", (source) => {
    expectProbesReported(source)
  })

  test.each([...fixtures, ...nestedFixtures])("reports or rejects real-shell execution: %j", (source) => {
    expectProbesReported(source)
  })

  test.each(wrappers.flatMap(([name, wrap]) => nestedFixtures.map((source) => [name, source, wrap(source)])))(
    "reports or rejects in %s: %j",
    (_, __, source) => {
      expectProbesReported(source)
    },
  )
})

describe.skipIf(process.platform === "win32")("real-shell directory oracle", () => {
  test.each(["cd >/dev/null TARGET", "cd 2>/dev/null TARGET", "cd $'TARGET'", 'cd "TARGET"'])(
    "reports the directory a real shell changes to: %s",
    async (template) => {
      const source = template.replace("TARGET", target)
      const targets = [target, fs.realpathSync(target)]
      const changed = shells.filter((executable) =>
        targets.includes(observe(executable, `${source}\npwd >> "$SCAN_PROBE_LOG"`).at(-1) ?? ""),
      )
      expect(changed.length, `Fixture never changed directory in any real shell: ${source}`).toBeGreaterThan(0)
      for (const executable of changed) {
        const parsed = await Effect.runPromiseExit(ShellParse.scanPortable(source, executable, root))
        if (Exit.isSuccess(parsed)) expect(parsed.value.directories, `${executable} in: ${source}`).toContain(target)
      }
    },
  )
})
