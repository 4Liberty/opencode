export * as ShellScan from "./scan.js"

export type OpaqueReason =
  | "command-substitution"
  | "compound-command"
  | "dynamic-command-name"
  | "dynamic-execution"
  | "heredoc"
  | "invalid-redirect"
  | "invalid-structure"
  | "unterminated-escape"
  | "unterminated-quote"

type Command = {
  resource: string
  words: string[]
  rawWords: string[]
  // Exclusive raw-token ends relative to resource, for source-shaped permission prefixes.
  wordEnds?: number[]
  statementHead?: true
  declaration?: true
  // Words after a trailing redirect are destinations in the legacy command span.
  redirectWordCount?: number
}

// Opaque describes a parsing limitation, not a permission decision.
export type Result = { kind: "scanned"; commands: Command[] } | { kind: "opaque"; reason: OpaqueReason }

const BASH_REDIRECTS = ["&>>", "&>", "<<<", "<<-", "<<", "<>", "<&", ">&", ">|", ">>", ">", "<"]
const BASH_LIST_OPERATORS = ["&&", "||", "|&"]
const BASH_CASE_OPERATORS = [";;&", ";;", ";&", ";|", ...BASH_LIST_OPERATORS]
const BASH_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"])
const BASH_NON_FUNCTION_KEYWORDS = new Set([
  "if",
  "for",
  "select",
  "case",
  "then",
  "elif",
  "else",
  "fi",
  "do",
  "done",
  "in",
  "esac",
])
const MAX_INPUT_LENGTH = 64 * 1024
const MAX_SUBSTITUTION_DEPTH = 32
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(?=(?:\\\n)*(?:[ \t\n;|&()<>]|$))/y
const BRACE_CLOSE_AHEAD_RE = /(?:\\\n)*(?:[ \t\n;&|()<>]|$)/y
const SPACE_CONTINUATION_AHEAD_RE = /(?:\\\n)*[ \t\n]/y
const NEGATION_AHEAD_RE = /(?:\\\n)*[ \t\n(]/y
const COPROC_AHEAD_RE = /coproc[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)?(?=[{(]|(?:if|while|until|for|case)\b)/y
const TIME_AHEAD_RE = /time[ \t]+(?:-p[ \t]+)?(?=[{(]|(?:if|while|until|for|case)\b)/y
// [function] name [()] then blanks, continuations, and comments before the body.
const FUNCTION_HEAD_RE =
  /(function[ \t](?:[ \t]|\\\n)*)?([A-Za-z_][\w.:+@%-]*)?(?:[ \t]|\\\n)*(\([ \t]*\))?(?:[ \t\n]|\\\n|#[^\n]*\n)*/y
const FUNCTION_BODY_RE = /[{(]|\[\[(?=(?:\\\n)*[ \t\n])|(?:if|while|until|for|select|case)(?=(?:\\\n)*(?:[ \t\n(]|$))/y
const DO_AHEAD_RE = /(?:[ \t\n;]|\\\n|#[^\n]*(?:\n|$))*(?:do(?=(?:\\\n)*(?:[ \t\n;{(]|$))|\{(?=(?:\\\n)*[ \t\n]))/y
const NOFORK_OPEN_RE = /\$\{(?:\\\n)*(?:[ \t\n]|\|)/y
const ZSH_EVALUATION_RE = /\([^)]*e[^)]*\)|(?:\([^)]*\))?[\^=]*~/y
const PARAMETER_SUBSCRIPT_RE = /[!#]?[A-Za-z_][A-Za-z0-9_]*\[/y
const BASH_ANSI_ESCAPES: Record<string, string> = {
  a: "\x07",
  b: "\b",
  e: "\x1b",
  E: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
  "\\": "\\",
  "'": "'",
  '"': '"',
  "?": "?",
}

type BashResult = { kind: "scanned"; commands: Command[]; end: number } | { kind: "opaque"; reason: OpaqueReason }

type BashState = {
  input: string
  commands: Command[]
  nestedCommands: Command[]
  words: string[]
  rawWords: string[]
  heredocs: Array<{ delimiter: string; quoted: boolean; tabs: boolean; command?: Command; start?: number }>
  structures: Array<{
    kind: "if" | "while" | "until" | "for" | "case"
    phase: "header" | "condition" | "pattern" | "body" | "do"
    count: number
    sawElse?: boolean
    sawIn?: boolean
    patternStarted?: boolean
    parenthesized?: boolean
  }>
  word: string
  literal: string
  wordStarted: boolean
  wordStart: number
  wordEnd: number
  commandStart: number | undefined
  commandEnd: number
  resourceEnd: number | undefined
  redirectWordCount: number | undefined
  // Dash reads `&>` as `&` and `>`, so later words would start another command there.
  ampersandRedirectWords: number | undefined
  commandWordIndex: number
  assignmentWord: boolean
  assignmentHeadUnsafe: boolean
  invalid: OpaqueReason | undefined
  redirectTarget: boolean
  hasRedirect: boolean
  compoundEnd: boolean
  // A list operator (&&, ||, |, |&) still awaits its right-hand command.
  dangling: boolean
}

type Opaque = { kind: "opaque"; reason: OpaqueReason }

// Cooked word text, and the literal text the word decodes to apart from its expansions.
type BashText = { word: string; literal: string }

export function scan(input: string): Result {
  if (input.length > MAX_INPUT_LENGTH) return { kind: "opaque", reason: "invalid-structure" }
  const result = scanBash(input, 0, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH })
  if (result.kind === "opaque") return result
  return { kind: "scanned", commands: result.commands }
}

function bashStatement(state: BashState) {
  const structure = state.structures.at(-1)
  if (structure) structure.count++
}

function bashInHeader(state: BashState) {
  const phase = state.structures.at(-1)?.phase
  return phase === "header" || phase === "pattern" || phase === "do"
}

function atCommandStart(state: BashState) {
  return !state.words.length && !state.hasRedirect && !state.compoundEnd && !bashInHeader(state)
}

function pending(state: BashState) {
  return state.wordStarted || state.words.length > 0 || state.hasRedirect || state.compoundEnd
}

// Ends the current list; false when an operator still awaits its command.
function endBashList(state: BashState) {
  if (pending(state)) finishBashCommand(state)
  return !state.dangling
}

function closeBashList(state: BashState, end: number): BashResult {
  if (!endBashList(state)) return { kind: "opaque", reason: "invalid-structure" }
  if (state.invalid) return { kind: "opaque", reason: state.invalid }
  if (state.structures.length) return { kind: "opaque", reason: "compound-command" }
  return { kind: "scanned", commands: state.commands, end }
}

function finishBashWord(state: BashState) {
  if (!state.wordStarted) return
  if (bashEvaluatesSubscript(state.literal)) state.invalid ??= "dynamic-execution"
  if (!state.redirectTarget) {
    if (!state.assignmentWord && state.commandWordIndex < 0) state.commandWordIndex = state.words.length
    state.commandStart ??= state.wordStart
    state.words.push(state.word)
    // Unquoted trailing continuations are ignored syntax, not part of the raw token.
    state.rawWords.push(state.input.slice(state.wordStart, state.wordEnd))
    state.commandEnd = state.wordEnd
  }
  state.redirectTarget = false
  state.word = ""
  state.literal = ""
  state.wordStarted = false
  state.assignmentWord = false
  state.assignmentHeadUnsafe = false
}

function finishBashCommand(state: BashState, boundary = false) {
  finishBashWord(state)
  if (state.redirectTarget) state.invalid ??= "invalid-redirect"
  state.redirectTarget = false
  if (state.compoundEnd && state.words.length > 0) state.invalid ??= "invalid-structure"
  const name = state.commandWordIndex
  const inHeader = bashInHeader(state)
  if (name >= 0 && !state.words[name]) state.invalid ??= "invalid-structure"
  if (name >= 0 && !inHeader) {
    const resource = state.input
      .slice(state.commandStart, state.resourceEnd ?? state.wordEnd)
      .replace(/^[ \t\n]+|[ \t\n]+$/g, "")
    const command: Command = {
      resource,
      words: state.words.slice(name),
      rawWords: state.rawWords.slice(name),
      ...(name === 0 && BASH_DECLARATIONS.has(state.rawWords[0]) && resource.startsWith(state.rawWords[0])
        ? { declaration: true as const }
        : {}),
      ...(state.redirectWordCount !== undefined && state.redirectWordCount < state.words.length
        ? { redirectWordCount: state.redirectWordCount - name }
        : {}),
    }
    state.commands.push(command)
    if (state.resourceEnd === undefined) {
      for (const heredoc of state.heredocs) {
        if (heredoc.command) continue
        heredoc.command = command
        heredoc.start = state.commandStart
      }
    }
  }
  if (boundary && !state.words.length && !state.hasRedirect && !state.compoundEnd && !inHeader)
    state.invalid ??= "invalid-structure"
  if (state.words.length > (state.ampersandRedirectWords ?? Infinity)) state.invalid ??= "invalid-redirect"
  state.commands.push(...state.nestedCommands.splice(0))
  if (!inHeader && (state.words.length > 0 || state.hasRedirect)) bashStatement(state)
  state.words.length = 0
  state.rawWords.length = 0
  state.commandWordIndex = -1
  state.commandStart = undefined
  state.hasRedirect = false
  state.resourceEnd = undefined
  state.redirectWordCount = undefined
  state.ampersandRedirectWords = undefined
  state.compoundEnd = false
  state.dangling = false
}

function scanBash(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  close?: ")" | "}" | "nofork",
): BashResult {
  if (depth > MAX_SUBSTITUTION_DEPTH || budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
  const state: BashState = {
    input,
    commands: [],
    nestedCommands: [],
    words: [],
    rawWords: [],
    heredocs: [],
    structures: [],
    word: "",
    literal: "",
    wordStarted: false,
    wordStart: start,
    wordEnd: start,
    commandStart: undefined,
    commandEnd: start,
    resourceEnd: undefined,
    redirectWordCount: undefined,
    ampersandRedirectWords: undefined,
    commandWordIndex: -1,
    assignmentWord: false,
    assignmentHeadUnsafe: false,
    invalid: undefined,
    redirectTarget: false,
    hasRedirect: false,
    compoundEnd: false,
    dangling: false,
  }
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    // Line continuations are removed before tokens are read.
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    if (!state.wordStarted) {
      state.wordStart = index
      if (char === " " || char === "\t") continue
      if (
        char === "}" &&
        state.words.length === 0 &&
        !state.redirectTarget &&
        (close === "}" || close === "nofork") &&
        state.structures.length === 0 &&
        state.heredocs.length === 0 &&
        (close === "nofork" || ((BRACE_CLOSE_AHEAD_RE.lastIndex = index + 1), BRACE_CLOSE_AHEAD_RE.test(input)))
      )
        return closeBashList(state, index)
      if (char === "}")
        return { kind: "opaque", reason: state.structures.length ? "compound-command" : "invalid-structure" }
      const step = scanBashCommandStart(state, index, depth, budget)
      if (typeof step === "object") return step
      if (step !== undefined) {
        index = step
        continue
      }
    }
    if (char === "\\" && index + 1 >= input.length) return { kind: "opaque", reason: "unterminated-escape" }
    if (input.startsWith("$$'", index)) {
      const nextQuote = input.indexOf("'", index + 3)
      if (nextQuote < 0) return { kind: "opaque", reason: "unterminated-quote" }
      // Zsh parses $$'...' with ANSI-C escapes while Bash/Dash treat $$ as PID followed by '...'.
      if (input.slice(index + 3, nextQuote).includes("\\") && input.includes("'", nextQuote + 1)) {
        const lineEnd = input.indexOf("\n", nextQuote + 1)
        const tail = input.slice(nextQuote + 1, lineEnd < 0 ? input.length : lineEnd)
        const hashIndex = tail.indexOf("#")
        if (hashIndex < 0 || tail.slice(0, hashIndex).includes("'"))
          return { kind: "opaque", reason: "unterminated-quote" }
      }
    }
    if (
      !state.assignmentWord &&
      ("'\"\\".includes(char) || (char === "$" && (input[index + 1] === "'" || input[index + 1] === '"')))
    )
      state.assignmentHeadUnsafe = true
    const inCasePattern = state.structures.at(-1)?.phase === "pattern"
    if (char === "=" && !state.wordStarted && input[index + 1] === "(") {
      const end = scanBashNested(input, index + 2, depth, budget, state.nestedCommands, ")")
      if (typeof end === "object") return end
      state.wordStarted = true
      state.word += input.slice(index, end + 1)
      index = end
      state.wordEnd = index + 1
      continue
    }
    const allowBracket =
      !state.assignmentWord && state.commandWordIndex >= 0 && !BASH_DECLARATIONS.has(state.rawWords[0])
    const unit = scanBashUnit(input, index, depth, budget, state.nestedCommands, "word", allowBracket, state)
    if (typeof unit === "object") return unit
    if (unit !== undefined) {
      state.wordStarted = true
      index = unit
      state.wordEnd = index + 1
      continue
    }
    if (
      char === "[" &&
      !inCasePattern &&
      !state.assignmentWord &&
      !state.assignmentHeadUnsafe &&
      state.commandWordIndex < 0 &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(state.word)
    ) {
      const subscript: Command[] = []
      const end = scanBashSpan(input, index + 1, depth, budget, subscript, BASH_SPANS.assignmentSubscript, false)
      if (typeof end === "object") return end
      if (input[end + 1] === "=" || input.startsWith("+=", end + 1)) {
        state.nestedCommands.push(...subscript)
        state.assignmentWord = true
        state.word += input.slice(index, end + 1)
        index = end
        state.wordEnd = index + 1
        continue
      }
    }
    // Elsewhere a parenthesized group inside a word is a Zsh glob qualifier, which can run code.
    const array =
      state.assignmentWord &&
      state.word.endsWith("=") &&
      (state.commandWordIndex < 0 || BASH_DECLARATIONS.has(state.rawWords[state.commandWordIndex]))
    if (char === "(" && (array || (inCasePattern && /[?*+@!]$/.test(state.word)))) {
      const mode = array ? "array" : "pattern"
      const end = scanBashArrayOrPattern(input, index, depth + 1, budget, state.nestedCommands, mode)
      if (typeof end === "object") return end
      state.wordStarted = true
      state.word += input.slice(index, end + 1)
      index = end
      state.wordEnd = index + 1
      continue
    }
    if (char === "#" && !state.wordStarted) {
      const newline = input.indexOf("\n", index)
      if (newline === -1) break
      index = newline - 1
      continue
    }
    if ("<>&|;\n".includes(char)) {
      const step = scanBashOperatorOrSeparator(state, index, depth, budget)
      if (typeof step === "object") return step
      index = step
      continue
    }
    if (inCasePattern && char === ")") {
      finishBashWord(state)
      index--
      continue
    }
    if (char === ")") {
      if (close !== ")" || state.structures.length > 0 || state.heredocs.length > 0)
        return { kind: "opaque", reason: "compound-command" }
      return closeBashList(state, index)
    }
    if (char === "(") return { kind: "opaque", reason: state.wordStarted ? "dynamic-execution" : "compound-command" }
    if (/\s/.test(char) && !" \t\n".includes(char)) return { kind: "opaque", reason: "invalid-structure" }
    if (char === " " || char === "\t") {
      finishBashWord(state)
      continue
    }
    state.wordStarted = true
    if (
      char === "=" &&
      !state.assignmentWord &&
      !state.assignmentHeadUnsafe &&
      /^[A-Za-z_][A-Za-z0-9_]*\+?$/.test(state.word)
    )
      state.assignmentWord = true
    bashAppend(state, char)
    state.wordEnd = index + 1
  }

  if (close) return { kind: "opaque", reason: close === ")" ? "command-substitution" : "invalid-structure" }
  if (state.heredocs.length) return { kind: "opaque", reason: "heredoc" }
  return closeBashList(state, input.length)
}

// Steps return the last consumed index.
function scanBashOperatorOrSeparator(
  state: BashState,
  index: number,
  depth: number,
  budget: { remaining: number },
): number | Opaque {
  const input = state.input
  const char = input[index]
  const redirect = "<>&".includes(char) ? bashOperator(input, index, BASH_REDIRECTS) : undefined
  if (typeof redirect === "object") return redirect
  if (redirect) {
    state.hasRedirect = true
    state.commandStart ??= state.wordStart
    if (state.redirectTarget) state.invalid ??= "invalid-redirect"
    const fdPrefix =
      state.wordStarted && !state.assignmentHeadUnsafe && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(state.word)
    if (fdPrefix) {
      // A continuation separates the legacy number token from the redirect descriptor.
      if (state.wordEnd < index) state.commandEnd = state.wordEnd
      state.word = ""
      state.literal = ""
      state.wordStarted = false
    }
    if (!fdPrefix) finishBashWord(state)
    if (redirect.startsWith("&")) state.ampersandRedirectWords ??= state.words.length
    // Trailing redirects wrap a whole list/pipeline in the legacy grammar, not its last command.
    // Prefix redirects remain part of the command, and later words remain redirect destinations.
    if (state.redirectWordCount === undefined && state.commandWordIndex >= 0) {
      state.redirectWordCount = state.words.length
      if (state.dangling) state.resourceEnd = state.commandEnd
    }
    if (redirect === "<<" || redirect === "<<-") {
      const delimiter = bashHeredocDelimiter(input, index + redirect.length, redirect === "<<-")
      if (!delimiter) return { kind: "opaque", reason: "invalid-redirect" }
      state.heredocs.push(delimiter)
      state.wordEnd = delimiter.end + 1
      state.redirectTarget = false
      return delimiter.end
    }
    state.redirectTarget = true
    return index + redirect.length - 1
  }
  if (state.structures.at(-1)?.phase === "pattern" && char === "|") {
    finishBashWord(state)
    return index - 1
  }
  const structure = state.structures.at(-1)
  const caseBody = structure?.kind === "case" && structure.phase === "body"
  const operator = bashOperator(input, index, caseBody ? BASH_CASE_OPERATORS : BASH_LIST_OPERATORS)
  if (typeof operator === "object") return operator
  const separator = operator ?? char
  if (caseBody && separator.startsWith(";") && separator.length > 1) {
    if (!endBashList(state)) return { kind: "opaque", reason: "invalid-structure" }
    structure.phase = "pattern"
    structure.patternStarted = false
    return index + separator.length - 1
  }
  if (structure?.kind === "case" && (structure.phase === "header" || structure.phase === "pattern")) {
    if (separator !== "\n") return { kind: "opaque", reason: "compound-command" }
    if (structure.phase === "pattern" && (state.wordStarted || state.words.length > 0))
      return { kind: "opaque", reason: "compound-command" }
    finishBashWord(state)
    return index
  }
  if (structure?.kind === "for" && (structure.phase === "header" || structure.phase === "do")) {
    if (separator !== ";" && separator !== "\n") return { kind: "opaque", reason: "compound-command" }
    if (structure.phase === "header" && !structure.sawIn && !state.wordStarted && state.words.length === 0)
      return { kind: "opaque", reason: "compound-command" }
  }
  if (separator === "\n" && !pending(state)) {
    let nextIndex = index
    for (const heredoc of state.heredocs.splice(0)) {
      const body = bashHeredoc(input, nextIndex + 1, heredoc)
      if (!body) return { kind: "opaque", reason: "heredoc" }
      if (heredoc.command) heredoc.command.resource = input.slice(heredoc.start, body.end).trim()
      if (!heredoc.quoted) {
        const expansion = scanBashSpan(body.source, 0, depth, budget, state.commands, BASH_SPANS.heredoc, true)
        if (typeof expansion === "object") return expansion
      }
      nextIndex = body.end
    }
    return nextIndex
  }
  finishBashCommand(state, true)
  if (structure?.kind === "for" && structure.phase === "header") structure.phase = "do"
  state.dangling = separator !== "&" && separator !== ";" && separator !== "\n"
  // Reprocess the newline to read pending heredoc bodies.
  if (separator === "\n" && state.heredocs.length) return index - 1
  return index + separator.length - 1
}

function scanBashCommandStart(
  state: BashState,
  index: number,
  depth: number,
  budget: { remaining: number },
): number | Opaque | undefined {
  const input = state.input
  const char = input[index]
  const structure = state.structures.at(-1)
  if (structure?.phase === "pattern" && !structure.patternStarted && !state.words.length && char === "(") {
    structure.patternStarted = true
    return index
  }
  if (structure?.phase === "pattern" && char === "|") {
    if (!state.words.length) return { kind: "opaque", reason: "compound-command" }
    finishBashWord(state)
    structure.patternStarted = true
    return index
  }
  if (structure?.phase === "pattern" && char === ")") {
    if (!state.words.length) return { kind: "opaque", reason: "compound-command" }
    finishBashCommand(state)
    structure.phase = "body"
    structure.count = 0
    return index
  }
  if (structure?.kind === "for" && structure.phase === "header" && char === "(" && input[index + 1] !== "(") {
    const end = scanBashArrayOrPattern(input, index, depth + 1, budget, state.nestedCommands, "array")
    if (typeof end === "object") return end
    finishBashCommand(state)
    // Zsh permits a sublist or brace group directly after the value list, without do/done.
    structure.phase = "do"
    structure.parenthesized = true
    DO_AHEAD_RE.lastIndex = end + 1
    if (!DO_AHEAD_RE.test(input)) state.structures.pop()
    return end
  }
  const keywordStep = scanBashKeyword(state, index, depth)
  if (keywordStep !== undefined) return keywordStep
  if (structure?.kind === "for" && structure.phase === "do" && char !== "\n" && char !== "#" && char !== ";") {
    SPACE_CONTINUATION_AHEAD_RE.lastIndex = index + 1
    if (char !== "{" || !SPACE_CONTINUATION_AHEAD_RE.test(input)) return { kind: "opaque", reason: "compound-command" }
    state.structures.pop()
  }
  const atStart = atCommandStart(state)
  const functionHead = atStart && char === "(" ? bashFunctionHeadLength(input, index) : 0
  if (functionHead) return index + functionHead - 1
  if (atStart && char === "!") {
    NEGATION_AHEAD_RE.lastIndex = index + 1
    if (NEGATION_AHEAD_RE.test(input)) return index
  }
  const forHeader = structure?.kind === "for" && structure.phase === "header"
  if ((atStart || forHeader) && input.startsWith("((", index)) {
    if (forHeader && state.words.length > 0) return { kind: "opaque", reason: "compound-command" }
    const commands: Command[] = []
    const span = forHeader ? BASH_SPANS.forArithmetic : BASH_SPANS.arithmetic
    const end = scanBashSpan(input, index + 2, depth, budget, commands, span, true)
    if (typeof end === "number" && input[end + 1] === ")") {
      state.commands.push(...commands)
      if (forHeader) {
        structure.phase = "do"
        structure.sawIn = true
      }
      if (!forHeader) {
        bashStatement(state)
        state.compoundEnd = true
      }
      return end + 1
    }
    if (forHeader || typeof end === "object") return { kind: "opaque", reason: "invalid-structure" }
  }
  if (
    atStart &&
    (char === "(" ||
      (char === "{" && ((SPACE_CONTINUATION_AHEAD_RE.lastIndex = index + 1), SPACE_CONTINUATION_AHEAD_RE.test(input))))
  ) {
    const group = scanBash(input, index + 1, depth + 1, budget, char === "{" ? "}" : ")")
    if (group.kind === "opaque") return group
    if (!input.slice(index + 1, group.end).trim()) return { kind: "opaque", reason: "invalid-structure" }
    state.commands.push(...group.commands)
    bashStatement(state)
    state.compoundEnd = true
    return group.end
  }
  if (
    atStart &&
    input.startsWith("[[", index) &&
    ((SPACE_CONTINUATION_AHEAD_RE.lastIndex = index + 2), SPACE_CONTINUATION_AHEAD_RE.test(input))
  ) {
    const end = scanBashConditional(input, index + 2, depth, budget, state.commands)
    if (typeof end === "object") return end
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  return undefined
}

function scanBashKeyword(state: BashState, index: number, depth: number): number | Opaque | undefined {
  const input = state.input
  const char = input[index]
  if (!((char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_")) return undefined
  const structure = state.structures.at(-1)
  TOKEN_RE.lastIndex = index
  const token = TOKEN_RE.exec(input)?.[0]
  const end = index + (token?.length ?? 0) - 1
  if (structure?.kind === "case" && structure.phase === "header" && token === "in") {
    if (state.words.length !== 1 || state.hasRedirect) return { kind: "opaque", reason: "compound-command" }
    finishBashCommand(state)
    structure.phase = "pattern"
    structure.patternStarted = false
    return end
  }
  if (
    structure?.kind === "for" &&
    (structure.phase === "header" || structure.phase === "do") &&
    !structure.sawIn &&
    !structure.parenthesized &&
    token === "in" &&
    (structure.phase === "do" || state.words.length >= 1)
  ) {
    structure.sawIn = true
    structure.phase = "header"
    return end
  }
  if (structure?.phase === "pattern" && !structure.patternStarted && !state.words.length && token === "esac") {
    state.structures.pop()
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  // POSIX `for name do` omits the in list.
  if (
    structure?.kind === "for" &&
    structure.phase === "header" &&
    !structure.sawIn &&
    state.words.length === 1 &&
    !state.hasRedirect &&
    token === "do"
  ) {
    finishBashCommand(state)
    structure.phase = "do"
  }
  const inHeader = bashInHeader(state)
  if (
    token &&
    ["then", "elif", "else", "fi", "do", "done", "esac"].includes(token) &&
    !state.words.length &&
    !state.redirectTarget &&
    (!inHeader || (token === "do" && structure?.phase === "do"))
  ) {
    // Bash and Dash read a reserved word after a redirect as a command word, while Zsh reads a keyword.
    if (state.hasRedirect || !endBashList(state) || !structure) return { kind: "opaque", reason: "compound-command" }
    if (token === "then") {
      if (structure.kind !== "if" || structure.phase !== "condition" || !structure.count)
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = "body"
      structure.count = 0
      return end
    }
    if (token === "elif" || token === "else") {
      if (structure.kind !== "if" || structure.phase !== "body" || !structure.count || structure.sawElse)
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = token === "elif" ? "condition" : "body"
      structure.sawElse = token === "else"
      structure.count = 0
      return end
    }
    if (token === "do") {
      if (
        !["for", "while", "until"].includes(structure.kind) ||
        !["condition", "do"].includes(structure.phase) ||
        (structure.kind !== "for" && !structure.count)
      )
        return { kind: "opaque", reason: "compound-command" }
      structure.phase = "body"
      structure.count = 0
      return end
    }
    if (
      (token === "fi" && (structure.kind !== "if" || structure.phase !== "body" || !structure.count)) ||
      (token === "done" &&
        (!["for", "while", "until"].includes(structure.kind) || structure.phase !== "body" || !structure.count)) ||
      (token === "esac" && (structure.kind !== "case" || structure.phase === "header"))
    )
      return { kind: "opaque", reason: "compound-command" }
    state.structures.pop()
    bashStatement(state)
    state.compoundEnd = true
    return end
  }
  if (!atCommandStart(state)) return undefined
  const definitionLength = bashFunctionHeadLength(input, index)
  if (definitionLength > 0) return index + definitionLength - 1
  if (
    token === "if" ||
    token === "while" ||
    token === "until" ||
    token === "for" ||
    token === "select" ||
    token === "case"
  ) {
    if (depth + state.structures.length >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "compound-command" }
    state.structures.push({
      kind: token === "select" ? "for" : token,
      phase: ["for", "select", "case"].includes(token) ? "header" : "condition",
      count: 0,
    })
    // The compound command itself satisfies a preceding list operator.
    state.dangling = false
    return end
  }
  if (token === "coproc") {
    COPROC_AHEAD_RE.lastIndex = index
    const coprocMatch = COPROC_AHEAD_RE.exec(input)?.[0]
    if (coprocMatch) return index + coprocMatch.length - 1
  }
  if (token === "time") {
    TIME_AHEAD_RE.lastIndex = index
    const timeMatch = TIME_AHEAD_RE.exec(input)?.[0]
    if (timeMatch) return index + timeMatch.length - 1
  }
  return undefined
}

function bashFunctionHeadLength(input: string, start: number) {
  FUNCTION_HEAD_RE.lastIndex = start
  const head = FUNCTION_HEAD_RE.exec(input)
  if (!head || (head[1] ? !head[2] : !head[3] || BASH_NON_FUNCTION_KEYWORDS.has(head[2] ?? ""))) return 0
  FUNCTION_BODY_RE.lastIndex = start + head[0].length
  return FUNCTION_BODY_RE.test(input) ? head[0].length : 0
}

// Word text is unquoted. Quoted text follows double-quote rules. Arithmetic text, including subscripts,
// expands like double-quoted text while its matcher still lets a backslash escape any character.
type BashTextMode = "word" | "quoted" | "arithmetic"

type BashSpan = { open?: string; close?: string; reject: string; mode: Exclude<BashTextMode, "word"> }

const BASH_SPANS = {
  double: { close: '"', reject: "", mode: "quoted" },
  heredoc: { reject: "", mode: "quoted" },
  arithmetic: { open: "(", close: ")", reject: ";", mode: "arithmetic" },
  forArithmetic: { open: "(", close: ")", reject: "", mode: "arithmetic" },
  bracketArithmetic: { close: "]", reject: ";|&<>()[\n'\"\\#", mode: "arithmetic" },
  subscript: { open: "[", close: "]", reject: "", mode: "arithmetic" },
  // Dash splits an assignment subscript at blanks and operators, so Bash and Zsh assignments diverge.
  assignmentSubscript: { open: "[", close: "]", reject: " \t\n\r\v\f;&|<>()", mode: "arithmetic" },
  // Single quotes are literal here in some shells and quoting in others, so reject what either reading
  // would parse structurally and scan the contents for expansions.
  arithmeticQuote: { close: "'", reject: "()[];", mode: "quoted" },
  parameterQuote: { close: "'", reject: '"}[]', mode: "quoted" },
} satisfies Record<string, BashSpan>

// Scans one quoting or expansion unit at index into commands, appending its text when given a sink.
// Returns the unit's last index, or undefined when the character is ordinary text.
function scanBashUnit(
  input: string,
  index: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  mode: BashTextMode,
  allowBracket: boolean,
  text?: BashText,
): number | Opaque | undefined {
  const char = input[index]
  const next = input[index + 1] ?? "\0"
  if (char === "\\") {
    if (mode === "quoted" && !'$`"\\\n'.includes(next)) return undefined
    if (text && next !== "\n") bashAppend(text, input.slice(index + 1, index + 2))
    return index + 1
  }
  // Zsh globs the value of $~name, which can run glob qualifier code.
  if (char === "$" && next === "~") return { kind: "opaque", reason: "dynamic-execution" }
  if (char === "$" && next === "$") {
    if (text) {
      text.word += "$$"
      text.literal += "\0"
    }
    return index + 1
  }
  if (mode === "word" && char === "$" && next === "'") {
    const quote = bashAnsiQuote(input, index + 1)
    if (!quote) return { kind: "opaque", reason: "unterminated-quote" }
    if (text) bashAppend(text, quote.value)
    return quote.end
  }
  if (mode === "word" && char === "'") {
    const end = input.indexOf("'", index + 1)
    if (end < 0) return { kind: "opaque", reason: "unterminated-quote" }
    if (text) bashAppend(text, input.slice(index + 1, end))
    return end
  }
  if (mode === "arithmetic" && char === "'")
    return scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.arithmeticQuote, allowBracket)
  if (mode === "word" && char === "$" && next === '"')
    return scanBashSpan(input, index + 2, depth, budget, commands, BASH_SPANS.double, allowBracket, text)
  if (mode !== "quoted" && char === '"')
    return scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.double, allowBracket, text)
  const opener =
    char === "$"
      ? bashOperator(input, index, ["$(", "${", "$["])
      : mode === "word" && (char === "<" || char === ">")
        ? bashOperator(input, index, [`${char}(`])
        : undefined
  if (typeof opener === "object") return opener
  const end =
    opener === "<(" || opener === ">("
      ? scanBashNested(input, index + 2, depth, budget, commands, ")")
      : opener || char === "`"
        ? scanBashDollarOrBacktick(input, index, depth, budget, commands, mode !== "word", allowBracket, text)
        : undefined
  if (text && typeof end === "number") {
    text.word += input.slice(index, end + 1)
    text.literal += "\0"
  }
  return end
}

function bashAppend(text: BashText, value: string) {
  text.word += value
  text.literal += value
}

// Builtins such as declare, unset, read, and printf -v, and arithmetic on a variable's value, evaluate
// `name[subscript]`, and declare evaluates `([subscript]=value)`. A literal expansion inside such a subscript
// runs when the word is evaluated. Quotes and escapes inside the brackets hide a closing bracket. NUL marks
// where an expansion's value may supply the name.
function bashEvaluatesSubscript(literal: string) {
  let depth = 0
  let quote: string | undefined
  let previous = ""
  for (let index = 0; index < literal.length; index++) {
    const char = literal[index]
    if (depth && (char === "`" || (char === "$" && "({".includes(literal[index + 1] ?? "\0")))) return true
    if (quote) {
      if (char === quote) quote = undefined
      continue
    }
    if (depth && (char === "'" || char === '"')) quote = char
    else if (depth && char === "\\") index++
    else if (char === "[" && (depth || /[\w\0(]/.test(previous))) depth++
    else if (char === "]" && depth) depth--
    if (!/\s/.test(char)) previous = char
  }
  return false
}

// Scans to the span's unnested close character and returns its index; a span without one runs to the end.
function scanBashSpan(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  span: BashSpan,
  allowBracket: boolean,
  text?: BashText,
): number | Opaque {
  let nesting = 0
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === span.close) {
      if (!nesting) return index
      nesting--
      continue
    }
    if (span.reject.includes(char)) return { kind: "opaque", reason: "invalid-structure" }
    if (char === span.open) {
      if (++nesting + depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "invalid-structure" }
      continue
    }
    const unit = scanBashUnit(input, index, depth, budget, commands, span.mode, allowBracket, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    else if (text) bashAppend(text, char)
  }
  return span.close ? { kind: "opaque", reason: "unterminated-quote" } : input.length
}

// Scans a nested list such as a command or process substitution and returns its closing index.
function scanBashNested(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  close: ")" | "nofork",
): number | Opaque {
  const nested = scanBash(input, start, depth + 1, budget, close)
  if (nested.kind === "opaque") return nested
  commands.push(...nested.commands)
  return nested.end
}

// Returns the first listed operator at index. Shells disagree about operators split by line continuations.
function bashOperator(input: string, index: number, operators: string[]): string | Opaque | undefined {
  let text = input[index]
  for (let cursor = index + 1; text.length < 3 && cursor < input.length; cursor++) {
    if (input.startsWith("\\\n", cursor)) cursor++
    else text += input[cursor]
  }
  const operator = operators.find((candidate) => text.startsWith(candidate))
  if (operator && !input.startsWith(operator, index)) return { kind: "opaque", reason: "invalid-structure" }
  return operator
}

function scanBashDollarOrBacktick(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  quoted: boolean,
  allowBracket: boolean,
  text?: BashText,
): number | Opaque {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  if (input[start] === "`") return scanBashBacktick(input, start, depth + 1, budget, commands, quoted)
  if (input.startsWith("$((", start)) {
    const arithmetic: Command[] = []
    const end = scanBashSpan(input, start + 3, depth + 1, budget, arithmetic, BASH_SPANS.arithmetic, true)
    if (typeof end === "object") return { kind: "opaque", reason: "command-substitution" }
    if (input[end + 1] === ")") {
      commands.push(...arithmetic)
      return end + 1
    }
  }
  if (input.startsWith("$(", start)) return scanBashNested(input, start + 2, depth, budget, commands, ")")
  NOFORK_OPEN_RE.lastIndex = start
  const nofork = NOFORK_OPEN_RE.exec(input)
  if (nofork) return scanBashNested(input, start + nofork[0].length, depth, budget, commands, "nofork")
  if (input.startsWith("${", start)) {
    // Literal text in parameter words reaches the enclosing word's value.
    const parameter = { word: "", literal: "" }
    const end = scanBashParameter(input, start + 2, depth + 1, budget, commands, quoted, parameter)
    if (text) text.literal += `\0${parameter.literal}`
    return end
  }
  if (!allowBracket) return { kind: "opaque", reason: "command-substitution" }
  return scanBashSpan(input, start + 2, depth + 1, budget, commands, BASH_SPANS.bracketArithmetic, true)
}

function scanBashBacktick(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  quoted: boolean,
): number | Opaque {
  let source = ""
  for (let index = start + 1; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    if (input[index] === "`") {
      const inner = scanBash(source, 0, depth, budget)
      if (inner.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      commands.push(...inner.commands)
      return index
    }
    const next = input[index + 1] ?? "\0"
    if (input[index] === "\\" && ("$`\\\n".includes(next) || (quoted && next === '"'))) {
      index++
      if (next !== "\n") source += next
      continue
    }
    source += input[index]
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashParameter(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  quoted: boolean,
  text: BashText,
): number | Opaque {
  // Bash ${name@P} and Zsh ${(e)name} and ${~name} evaluate the parameter's value as shell text.
  ZSH_EVALUATION_RE.lastIndex = start
  if (ZSH_EVALUATION_RE.test(input)) return { kind: "opaque", reason: "dynamic-execution" }
  PARAMETER_SUBSCRIPT_RE.lastIndex = start
  const subscript = PARAMETER_SUBSCRIPT_RE.test(input) ? PARAMETER_SUBSCRIPT_RE.lastIndex - 1 : -1
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "}") return index
    if (input.startsWith("@P}", index)) return { kind: "opaque", reason: "dynamic-execution" }
    // Zsh globs an unquoted parameter's words, where a parenthesized group can be a glob qualifier.
    if (!quoted && char === "(" && index > start) return { kind: "opaque", reason: "dynamic-execution" }
    const unit =
      index === subscript
        ? scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.subscript, false)
        : quoted && char === "'"
          ? scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.parameterQuote, false, text)
          : quoted && char === '"'
            ? scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.double, false, text)
            : scanBashUnit(input, index, depth, budget, commands, quoted ? "quoted" : "word", false, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    else bashAppend(text, char)
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashConditional(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
): number | Opaque {
  const text = { word: "", literal: "" }
  let wordStarted = false
  let parenDepth = 0
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    if (!wordStarted && text.literal) {
      if (bashEvaluatesSubscript(text.literal)) return { kind: "opaque", reason: "dynamic-execution" }
      text.literal = ""
    }
    if (!wordStarted && input.startsWith("]]", index)) {
      BRACE_CLOSE_AHEAD_RE.lastIndex = index + 2
      if (BRACE_CLOSE_AHEAD_RE.test(input)) {
        if (parenDepth !== 0) return { kind: "opaque", reason: "invalid-structure" }
        return index + 1
      }
    }
    if (!wordStarted && char === "#") {
      const newline = input.indexOf("\n", index)
      if (newline < 0) return { kind: "opaque", reason: "invalid-structure" }
      index = newline
      continue
    }
    if (char === " " || char === "\t" || char === "\n") {
      wordStarted = false
      continue
    }
    if (char === ";") return { kind: "opaque", reason: "invalid-structure" }
    if (char === "(" || char === ")") {
      if (char === ")" && parenDepth === 0) return { kind: "opaque", reason: "invalid-structure" }
      parenDepth += char === "(" ? 1 : -1
      wordStarted = false
      continue
    }
    const unit = scanBashUnit(input, index, depth, budget, commands, "word", true, text)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
    wordStarted = unit !== undefined || !"&|<>".includes(char)
    if (unit === undefined && wordStarted) text.literal += char
  }
  return { kind: "opaque", reason: "invalid-structure" }
}

function scanBashArrayOrPattern(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  commands: Command[],
  mode: "array" | "pattern",
): number | Opaque {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  let wordStarted = false
  for (let index = start + 1; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === ")") return index
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    if (mode === "array" && !wordStarted && char === "#") {
      const newline = input.indexOf("\n", index)
      if (newline < 0) return { kind: "opaque", reason: "command-substitution" }
      index = newline
      continue
    }
    if (char === " " || char === "\t" || (mode === "array" && char === "\n")) {
      wordStarted = false
      continue
    }
    // Array elements are globbed, where a parenthesized group can be a Zsh glob qualifier.
    if (char === "\n" || char === ";" || char === "&" || (mode === "array" && "|(".includes(char)))
      return { kind: "opaque", reason: "command-substitution" }
    wordStarted = true
    const unit =
      mode === "array" && char === "=" && input[index + 1] === "("
        ? scanBashNested(input, index + 2, depth, budget, commands, ")")
        : char === "("
          ? scanBashArrayOrPattern(input, index, depth + 1, budget, commands, mode)
          : char === "["
            ? scanBashSpan(input, index + 1, depth, budget, commands, BASH_SPANS.subscript, false)
            : scanBashUnit(input, index, depth, budget, commands, "word", false)
    if (typeof unit === "object") return unit
    if (unit !== undefined) index = unit
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function bashAnsiQuote(input: string, start: number) {
  let value = ""
  for (let index = start + 1; index < input.length; index++) {
    if (input[index] === "'") return { value, end: index }
    if (input[index] !== "\\") {
      value += input[index]
      continue
    }
    const escaped = input[++index]
    if (escaped in BASH_ANSI_ESCAPES) {
      value += BASH_ANSI_ESCAPES[escaped]
      continue
    }
    if (escaped === "c" && index + 1 < input.length) {
      value += String.fromCharCode(input[++index].toUpperCase().charCodeAt(0) & 31)
      continue
    }
    const digits =
      escaped === "x"
        ? /^[\da-fA-F]{1,2}/.exec(input.slice(index + 1, index + 3))?.[0]
        : escaped === "u"
          ? /^[\da-fA-F]{1,4}/.exec(input.slice(index + 1, index + 5))?.[0]
          : escaped === "U"
            ? /^[\da-fA-F]{1,8}/.exec(input.slice(index + 1, index + 9))?.[0]
            : /[0-7]/.test(escaped ?? "")
              ? /^[0-7]{1,3}/.exec(input.slice(index, index + 3))?.[0]
              : undefined
    if (!digits) {
      value += `\\${escaped}`
      continue
    }
    const octal = /[0-7]/.test(escaped)
    const point = parseInt(digits, octal ? 8 : 16)
    value += point <= 0x10ffff ? String.fromCodePoint(point) : ""
    index += digits.length - (octal ? 1 : 0)
  }
}

function bashHeredocDelimiter(input: string, start: number, tabs: boolean) {
  let delimiter = ""
  let quoted = false
  let quote: "'" | '"' | undefined
  let end = start
  let started = false
  for (let index = start; index < input.length; index++) {
    const char = input[index]
    if (!started && /[ \t]/.test(char)) continue
    if (!started && char === "#") return
    if (!quote && /[ \t\n;&|()<>]/.test(char)) return started ? { delimiter, quoted, tabs, end } : undefined
    if (!quote && input.startsWith("$'", index)) {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return
      delimiter += literal.value
      quoted = true
      started = true
      index = literal.end
      end = index
      continue
    }
    // Bash strips $ from $"..." heredoc delimiters while Zsh and Dash retain $.
    if (!quote && input.startsWith('$"', index)) return
    if (char === quote) {
      quote = undefined
      end = index
      continue
    }
    if (char === "\\" && quote !== "'") {
      const next = input[index + 1]
      if (next === undefined) return
      if (next === "\n") {
        index++
        continue
      }
      // Double quotes only remove escapes for shell-special characters.
      if (!quote || '$`"\\'.includes(next)) {
        quoted = true
        started = true
        delimiter += input[++index]
        end = index
        continue
      }
    }
    if (!quote && (char === "'" || char === '"')) {
      quote = char
      quoted = true
      started = true
      end = index
      continue
    }
    delimiter += char
    started = true
    end = index
  }
  if (started && !quote) return { delimiter, quoted, tabs, end }
}

function bashHeredoc(input: string, start: number, delimiter: { delimiter: string; tabs: boolean; quoted: boolean }) {
  const bodyStart = start
  let lineStart = start
  let line = ""
  // Backslashes ending the joined line; an odd count continues it.
  let backslashes = 0
  for (let index = start; index <= input.length; index++) {
    if (index < input.length && input[index] !== "\n") continue
    const text =
      delimiter.tabs && start === lineStart ? input.slice(start, index).replace(/^\t+/, "") : input.slice(start, index)
    let run = 0
    while (text[text.length - 1 - run] === "\\") run++
    backslashes = run === text.length ? backslashes + run : run
    const continued = !delimiter.quoted && backslashes % 2 === 1 && index < input.length
    // Joined lines only grow, so text past the delimiter's length cannot change the comparison.
    if (line.length <= delimiter.delimiter.length) line += continued ? text.slice(0, -1) : text
    if (continued) {
      backslashes--
      start = index + 1
      continue
    }
    if (line === delimiter.delimiter) {
      // Dash does not join backslash-continued delimiter lines; fail closed if a physical delimiter follows.
      if (start > lineStart && input.slice(index + 1).includes(delimiter.delimiter)) return
      return { source: input.slice(bodyStart, lineStart), end: index }
    }
    line = ""
    backslashes = 0
    start = index + 1
    lineStart = start
  }
}

export function scanPowerShell(input: string): Result {
  return scanPowerShellNested(input, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH })
}

function scanPowerShellNested(input: string, depth: number, budget: { remaining: number }, hash = false): Result {
  budget.remaining -= input.length
  if (input.length > MAX_INPUT_LENGTH || depth >= MAX_SUBSTITUTION_DEPTH || budget.remaining < 0)
    return { kind: "opaque", reason: "invalid-structure" }
  // PowerShell's Unicode quotes, dashes, and whitespace differ from JavaScript's token rules.
  if (/[\0\u0085\u2013-\u2015\u2018-\u201e\ufeff]/.test(input)) return { kind: "opaque", reason: "invalid-structure" }
  const commands: Command[] = []
  const nestedCommands: Command[] = []
  const words: string[] = []
  const rawWords: string[] = []
  const wordEnds: number[] = []
  let segment = 0
  let word = ""
  let started = false
  let wordStart = 0
  let quote: "single" | "double" | undefined
  let standalone = false
  let expression = hash
  let compound = false
  let stopParsing = false
  let commandEnd = 0
  let statementHead = true
  let invalid = false
  let redirectTarget = false
  let comment = false
  let dangling = false
  let invocation = false

  const finishWord = (end: number) => {
    if (!started) return
    // Generic tokens can spell stop-parsing with escapes or embedded quotes; literal strings cannot.
    if (word === "--%" && words.length > 0 && !expression && !/['"]/.test(input[wordStart])) stopParsing = true
    if (!redirectTarget) {
      if (!words.length && !invocation && !expression) segment = wordStart
      words.push(word)
      rawWords.push(input.slice(wordStart, end))
      wordEnds.push(end)
      dangling = false
    }
    commandEnd = end
    redirectTarget = false
    word = ""
    started = false
  }
  const finishCommand = (end: number, required = false) => {
    finishWord(end)
    const start = segment + input.slice(segment, commandEnd).search(/\S|$/)
    const resource = input.slice(start, commandEnd).trimEnd()
    if (words.length && !expression)
      commands.push({
        resource,
        words: [...words],
        rawWords: [...rawWords],
        wordEnds: wordEnds.map((end) => end - start),
        ...(statementHead && !invocation ? { statementHead: true as const } : {}),
      })
    else if ((!expression && invocation) || (required && !words.length && !nestedCommands.length)) invalid = true
    if (redirectTarget) invalid = true
    commands.push(...nestedCommands.splice(0))
    words.length = 0
    rawWords.length = 0
    wordEnds.length = 0
    redirectTarget = false
    invocation = false
    expression = hash
    compound = false
    stopParsing = false
  }

  for (let index = 0; index < input.length; index++) {
    const char = input[index]
    if (!started) wordStart = index
    if (stopParsing) {
      const stop = powerShellStopParsing(input, index)
      const text = input.slice(index, stop).trim()
      if (text) {
        wordStart = index + input.slice(index, stop).search(/\S/)
        word = text
        started = true
        finishWord(wordStart + text.length)
      }
      stopParsing = false
      index = stop - 1
      continue
    }
    if (quote === "single") {
      started = true
      if (char === "'" && input[index + 1] === "'") {
        word += "'"
        index++
      } else if (char === "'") {
        quote = undefined
        if (standalone) finishWord(index + 1)
      } else word += char
      continue
    }
    if (quote === "double") {
      if (char === '"' && input[index + 1] === '"') {
        word += '"'
        index++
      } else if (char === '"') {
        quote = undefined
        if (standalone) finishWord(index + 1)
      } else if (char === "`") {
        const escape = powerShellEscape(input, index)
        if (!escape) return { kind: "opaque", reason: "unterminated-escape" }
        word += escape.value
        index = escape.end
      } else if (char === "$" && input[index + 1] === "(") {
        const block = powerShellBlock(input, index + 1, depth)
        if (!block) return { kind: "opaque", reason: "invalid-structure" }
        const result = scanPowerShellNested(block.source, depth + 1, budget)
        if (result.kind === "opaque") return result
        nestedCommands.push(...result.commands)
        word += input.slice(index, block.end + 1)
        index = block.end
      } else word += char
      continue
    }
    if (char === "'" || char === '"') {
      if (!started && words.length === 0 && !invocation) expression = true
      quote = char === "'" ? "single" : "double"
      standalone = !started
      started = true
      continue
    }
    if (char === "`") {
      const escape = powerShellEscape(input, index)
      if (!escape) return { kind: "opaque", reason: "unterminated-escape" }
      // At a token boundary escaped whitespace is trivia, not a new argument.
      if (started || /\S/.test(escape.value)) {
        started = true
        word += escape.value
      }
      index = escape.end
      continue
    }
    if (!started && words.length > 0 && !expression && /^--%(?=$|[\s;|&(){}])/.test(input.slice(index))) {
      word = "--%"
      started = true
      finishWord(index + 3)
      stopParsing = true
      index += 2
      continue
    }
    if (char === "<" && input[index + 1] === "#" && !started) {
      const end = powerShellComment(input, index)
      if (end === undefined) return { kind: "opaque", reason: "invalid-structure" }
      if (!words.length && !invocation) segment = end + 1
      index = end
      continue
    }
    if (char === "#" && (!started || expression)) {
      if (words.length || started || invocation) finishCommand(index)
      statementHead = !dangling
      comment = true
      const endings = [input.indexOf("\n", index), input.indexOf("\r", index)].filter((ending) => ending >= 0)
      const newline = endings.length > 0 ? Math.min(...endings) : -1
      if (newline === -1) break
      comment = false
      index = input[newline] === "\r" && input[newline + 1] === "\n" ? newline + 1 : newline
      segment = index + 1
      continue
    }
    const redirect =
      !started && (char === ">" || char === "*" || /\d/.test(char)) ? powerShellRedirect(input, index) : undefined
    if (redirect === false) return { kind: "opaque", reason: "invalid-redirect" }
    if (redirect) {
      if (redirectTarget) return { kind: "opaque", reason: "invalid-redirect" }
      if (words.length === 0) return { kind: "opaque", reason: "invalid-redirect" }
      redirectTarget = !redirect.includes("&")
      index += redirect.length - 1
      commandEnd = index + 1
      continue
    }
    if (!started && !words.length && !invocation && !expression && /[A-Za-z]/.test(char)) {
      const keyword = /^[A-Za-z]+(?=$|[\s({])/.exec(input.slice(index))?.[0]?.toLowerCase()
      if (
        keyword &&
        /^(?:if|elseif|else|for|while|do|until|switch|function|filter|try|catch|finally|begin|process|end|clean|param|trap|class|enum|data|dynamicparam|using)$/.test(
          keyword,
        )
      ) {
        expression = true
        compound = true
        index += keyword.length - 1
        continue
      }
      if (keyword === "foreach" && /^foreach\s*\(/i.test(input.slice(index))) {
        expression = true
        compound = true
        index += keyword.length - 1
        continue
      }
      if (keyword && /^(?:return|throw|exit|break|continue)$/.test(keyword)) {
        index += keyword.length - 1
        segment = index + 1
        continue
      }
    }
    if (expression && !compound && (char === "=" || (/[-+*/%]/.test(char) && input[index + 1] === "="))) {
      finishWord(index)
      words.length = 0
      rawWords.length = 0
      wordEnds.length = 0
      expression = false
      if (char !== "=") index++
      segment = index + 1
      continue
    }
    if (expression && !started && /^in\b/i.test(input.slice(index))) {
      words.length = 0
      rawWords.length = 0
      wordEnds.length = 0
      expression = false
      index++
      segment = index + 1
      continue
    }
    if (char === "@" && /['"]/.test(input[index + 1] ?? "")) {
      const literal = powerShellHereString(input, index)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      if (!words.length && !invocation) expression = true
      if (input[index + 1] === '"') {
        const result = powerShellExpansions(literal.source, depth + 1, budget)
        if (result.kind === "opaque") return result
        nestedCommands.push(...result.commands)
      }
      word = literal.source
      started = true
      index = literal.end
      finishWord(index + 1)
      continue
    }
    if (char === "$" && input[index + 1] === "{") {
      const end = input.indexOf("}", index + 2)
      if (end < 0) return { kind: "opaque", reason: "invalid-structure" }
      if (!started && !words.length && !invocation) expression = true
      word += input.slice(index, end + 1)
      started = true
      index = end
      continue
    }
    const opener =
      (char === "$" || char === "@") && input[index + 1] === "("
        ? index + 1
        : char === "@" && input[index + 1] === "{"
          ? index + 1
          : char === "(" || char === "{" || (char === "[" && (expression || !started))
            ? index
            : undefined
    if (opener !== undefined) {
      if (started && (char === "{" || char === "(")) {
        finishWord(index)
        wordStart = index
      }
      if (!started && !words.length && !invocation) expression = true
      const block = powerShellBlock(input, opener, depth)
      if (!block) return { kind: "opaque", reason: "invalid-structure" }
      const result = scanPowerShellNested(
        block.source,
        depth + 1,
        budget,
        input[opener] === "[" || (char === "@" && input[opener] === "{"),
      )
      if (result.kind === "opaque") return result
      nestedCommands.push(...result.commands)
      started = true
      word += input.slice(index, block.end + 1)
      index = block.end
      if (input[opener] === "{" || char === "(") finishWord(index + 1)
      if (compound && input[opener] === "{") {
        finishCommand(index + 1)
        segment = index + 1
      }
      continue
    }
    if (char === "}" || char === ")") return { kind: "opaque", reason: "invalid-structure" }
    if (
      !started &&
      words.length === 0 &&
      ((char === "&" && input[index + 1] !== "&") ||
        (char === "." && (/\s/.test(input[index + 1] ?? "") || !input[index + 1])))
    ) {
      if (invocation) return { kind: "opaque", reason: "invalid-structure" }
      invocation = true
      continue
    }
    if (!started && !words.length && !invocation && powerShellExpression(input.slice(index))) expression = true
    if (/\s/.test(char) && char !== "\n" && char !== "\r") {
      finishWord(index)
      continue
    }
    const next = input[index + 1]
    const separator =
      char === "\r" && next === "\n"
        ? char + next
        : (char === "&" && next === "&") || (char === "|" && next === "|")
          ? char + next
          : char === ";" || char === "|" || char === "&" || char === "\n" || char === "\r"
            ? char
            : undefined
    if (separator) {
      if (
        (separator === "\n" || separator === "\r" || separator === "\r\n") &&
        !started &&
        !words.length &&
        !invocation
      ) {
        index += separator.length - 1
        segment = index + 1
        continue
      }
      finishCommand(index, dangling || ![";", "\n", "\r", "\r\n"].includes(separator))
      dangling = ![";", "&", "\n", "\r", "\r\n"].includes(separator)
      statementHead = !dangling
      index += separator.length - 1
      segment = index + 1
      continue
    }
    started = true
    dangling = false
    word += char
  }

  if (quote) return { kind: "opaque", reason: "unterminated-quote" }
  if (!comment) finishCommand(input.length)
  if (redirectTarget || invalid || dangling) return { kind: "opaque", reason: "invalid-structure" }
  if (commands.some((command) => !command.words[0])) return { kind: "opaque", reason: "dynamic-command-name" }
  return { kind: "scanned", commands }
}

function powerShellBlock(input: string, start: number, depth: number): { source: string; end: number } | undefined {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return
  let quote: "single" | "double" | undefined
  let standalone = false
  let started = false
  let head = true
  let expression = false
  let token = ""
  const close = input[start] === "(" ? ")" : input[start] === "[" ? "]" : "}"
  for (let index = start + 1; index < input.length; index++) {
    const char = input[index]
    if (quote === "single") {
      if (char === "'" && input[index + 1] === "'") {
        token += "'"
        index++
      } else if (char === "'") {
        quote = undefined
        started = !standalone
        if (standalone) token = ""
      } else token += char
      continue
    }
    if (quote === "double") {
      if (char === "`") {
        const escape = powerShellEscape(input, index)
        if (!escape) return
        token += escape.value
        index = escape.end
      } else if (char === '"' && input[index + 1] === '"') {
        token += '"'
        index++
      } else if (char === '"') {
        quote = undefined
        started = !standalone
        if (standalone) token = ""
      } else if (char === "$" && input[index + 1] === "(") {
        const nested = powerShellBlock(input, index + 1, depth + 1)
        if (!nested) return
        index = nested.end
      } else token += char
      continue
    }
    if (char === "`") {
      const escape = powerShellEscape(input, index)
      if (!escape) return
      if (started || /\S/.test(escape.value)) {
        started = true
        token += escape.value
      }
      index = escape.end
      continue
    }
    if (char === "<" && input[index + 1] === "#" && !started) {
      const end = powerShellComment(input, index)
      if (end === undefined) return
      index = end
      continue
    }
    if (char === "#" && (!started || expression)) {
      const endings = [input.indexOf("\n", index), input.indexOf("\r", index)].filter((ending) => ending >= 0)
      const newline = endings.length > 0 ? Math.min(...endings) : -1
      if (newline < 0) return
      index = newline
      started = false
      head = true
      expression = false
      token = ""
      continue
    }
    if (char === "@" && /['"]/.test(input[index + 1] ?? "")) {
      const literal = powerShellHereString(input, index)
      if (!literal) return
      index = literal.end
      started = false
      head = false
      continue
    }
    if (
      head &&
      !started &&
      ((char === "&" && input[index + 1] !== "&") || (char === "." && /\s/.test(input[index + 1] ?? "")))
    ) {
      head = false
      continue
    }
    if (expression && (char === "=" || (!started && /^in\b/i.test(input.slice(index))))) {
      if (char !== "=") index++
      expression = false
      head = true
      started = false
      token = ""
      continue
    }
    if (char === "'" || char === '"') {
      quote = char === "'" ? "single" : "double"
      standalone = !started
      if (head && !started) expression = true
      started = true
      continue
    }
    const redirect =
      !started && (char === ">" || char === "*" || /\d/.test(char)) ? powerShellRedirect(input, index) : undefined
    if (redirect === false) return
    if (redirect) {
      index += redirect.length - 1
      token = ""
      continue
    }
    if (char === "$" && input[index + 1] === "{") {
      const end = input.indexOf("}", index + 2)
      if (end < 0) return
      if (head && !started) expression = true
      index = end
      started = true
      continue
    }
    if (!started && !head && !expression && /^--%(?=$|[\s;|&(){}])/.test(input.slice(index))) {
      index = powerShellStopParsing(input, index + 3) - 1
      continue
    }
    if (char === close) return { source: input.slice(start + 1, index), end: index }
    if (char === "(" || char === "{" || (char === "[" && (!started || expression))) {
      if (head && !started) expression = true
      const nested = powerShellBlock(input, index, depth + 1)
      if (!nested) return
      index = nested.end
      started = false
      head = false
      token = ""
      continue
    }
    if (/[\s;&|]/.test(char)) {
      if (token === "--%" && !expression) {
        index = powerShellStopParsing(input, index) - 1
        token = ""
        continue
      }
      if (/[;&|\r\n]/.test(char)) {
        head = true
        expression = false
      } else if (started) head = false
      started = false
      token = ""
      continue
    }
    if (head && !started && powerShellExpression(input.slice(index))) expression = true
    started = true
    token += char
  }
}

const POWERSHELL_ESCAPES: Record<string, string> = {
  "0": "\0",
  a: "\x07",
  b: "\b",
  e: "\x1b",
  f: "\f",
  n: "\n",
  r: "\r",
  t: "\t",
  v: "\v",
}

function powerShellEscape(input: string, start: number) {
  const char = input[start + 1]
  if (char === undefined) return
  if (char === "\r" || char === "\n")
    return {
      value: char === "\r" && input[start + 2] === "\n" ? "\r\n" : char,
      end: start + (char === "\r" && input[start + 2] === "\n" ? 2 : 1),
    }
  if (char === "u" && input[start + 2] === "{") {
    const code = /^u\{([0-9a-f]{1,6})\}/i.exec(input.slice(start + 1))
    if (!code || Number.parseInt(code[1], 16) > 0x10ffff) return
    return { value: String.fromCodePoint(Number.parseInt(code[1], 16)), end: start + code[0].length }
  }
  return { value: POWERSHELL_ESCAPES[char] ?? char, end: start + 1 }
}

function powerShellExpression(input: string) {
  return /^(?:[$!,+]|[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?(?:[dDlLnNuU]|[kKmMgGtTpP][bB])?(?![\w'"`])|0[xX][\da-fA-F]+\b|0[bB][01]+\b|\.[0-9]|-(?:not|bnot|join|split)\b)/i.test(
    input,
  )
}

function powerShellStopParsing(input: string, start: number) {
  let quoted = false
  for (let index = start; index < input.length; index++) {
    if (input[index] === '"') quoted = !quoted
    if (input[index] === "\r" || input[index] === "\n" || (input[index] === "|" && !quoted)) return index
  }
  return input.length
}

function powerShellComment(input: string, start: number) {
  const end = input.indexOf("#>", start + 2)
  return end < 0 ? undefined : end + 1
}

function powerShellHereString(input: string, start: number) {
  const header = /^@['"][ \t]*(?:\r\n|\r|\n)/.exec(input.slice(start))
  if (!header) return
  const body = start + header[0].length
  for (let index = body; index < input.length; index++) {
    if (index !== body && input[index - 1] !== "\r" && input[index - 1] !== "\n") continue
    if (input[index] !== input[start + 1] || input[index + 1] !== "@") continue
    const end =
      index > body && input[index - 1] === "\n" && input[index - 2] === "\r"
        ? index - 2
        : index > body
          ? index - 1
          : index
    return { source: input.slice(body, end), end: index + 1 }
  }
}

function powerShellExpansions(input: string, depth: number, budget: { remaining: number }): Result {
  const commands: Command[] = []
  for (let index = 0; index < input.length; index++) {
    if (input[index] === "`") {
      index++
      continue
    }
    if (!input.startsWith("$(", index)) continue
    const block = powerShellBlock(input, index + 1, depth)
    if (!block) return { kind: "opaque", reason: "invalid-structure" }
    const result = scanPowerShellNested(block.source, depth + 1, budget)
    if (result.kind === "opaque") return result
    commands.push(...result.commands)
    index = block.end
  }
  return { kind: "scanned", commands }
}

function powerShellRedirect(input: string, index: number) {
  let cursor = index
  if (input[cursor] === "*") cursor++
  else while (/\d/.test(input[cursor] ?? "")) cursor++
  if (input[cursor] !== ">") return
  cursor++
  if (input[cursor] === ">") cursor++
  if (input[cursor] === "&") {
    cursor++
    while (/\d/.test(input[cursor] ?? "")) cursor++
  }
  const redirect = input.slice(index, cursor)
  return /^(?:(?:[1-6]|\*)?>>?|[2-6*]>&1)$/.test(redirect) ? redirect : false
}
