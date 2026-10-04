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
const BASH_DECLARATIONS = new Set(["declare", "typeset", "export", "readonly", "local", "unset", "unsetenv"])
const MAX_INPUT_LENGTH = 64 * 1024
const MAX_SUBSTITUTION_DEPTH = 32
const TOKEN_RE = /[A-Za-z_][A-Za-z0-9_]*(?=(?:\\\n)*(?:[ \t\n;|&()<>]|$))/y
const FUNCTION_HEAD_RE =
  /(?!if(?:[ \t]|\\\n)*\()(?:function[ \t]+(?:\\\n[ \t]*)*[A-Za-z_][A-Za-z0-9_.:+@%/-]*(?:(?:[ \t]|\\\n)*\([ \t]*\))?|(?:(?!(?:for|select|case|then|elif|else|fi|do|done|in|esac)\b)[A-Za-z_][A-Za-z0-9_.:+@%/-]*(?:[ \t]|\\\n)*)?\([ \t]*\))(?:[ \t\n]|\\\n|#[^\n]*(?:\n|$))*(?=[{(]|\[\[(?=(?:\\\n)*[ \t\n])|(?:if|while|until|for|select|case)(?=(?:\\\n)*(?:[ \t\n(]|$)))/y
const DO_AHEAD_RE = /(?:[ \t\n;]|\\\n|#[^\n]*(?:\n|$))*(?:do(?=(?:\\\n)*(?:[ \t\n;{(]|$))|\{(?=(?:\\\n)*[ \t\n]))/y
const NOFORK_OPEN_RE = /\$\{(?:\\\n)*(?:[ \t\n]|\|)/y
const SUBSCRIPT_ASSIGN_RE = /\[(?:[^\]\n;|&<>'"`\\$()]|\$\([^)]*\)|`[^`]*`|\$\{[^}]*\})+\]\+?=/y

type BashListResult = { kind: "scanned"; commands: Command[]; end: number } | { kind: "opaque"; reason: OpaqueReason }
type BashSpanResult = { kind: "scanned"; commands: Command[]; end: number } | { kind: "opaque"; reason: OpaqueReason }

export function scan(input: string): Result {
  if (input.length > MAX_INPUT_LENGTH) return { kind: "opaque", reason: "invalid-structure" }
  const result = scanBash(input, 0, 0, { remaining: MAX_INPUT_LENGTH * MAX_SUBSTITUTION_DEPTH })
  if (result.kind === "opaque") return result
  return { kind: "scanned", commands: result.commands }
}

function scanBash(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  close?: ")" | "}" | "nofork",
): BashListResult {
  if (depth > MAX_SUBSTITUTION_DEPTH || budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
  const commands: Command[] = []
  const nestedCommands: Command[] = []
  const words: string[] = []
  const rawWords: string[] = []
  const assignmentWords: boolean[] = []
  let word = ""
  let wordStarted = false
  let wordStart = start
  let wordEnd = start
  let commandEnd = start
  let resourceEnd: number | undefined
  let redirectWordCount: number | undefined
  let assignmentWord = false
  let assignmentHeadUnsafe = false
  let segment = start
  let quote: "single" | "double" | undefined
  let invalidRedirect = false
  let invalidStructure = false
  let separated = false
  let redirectTarget = false
  let hasRedirect = false
  let dangling = false
  let inList = false
  let compoundEnd = false
  let statements = 0
  const heredocs: Array<{ delimiter: string; quoted: boolean; tabs: boolean; command?: Command; start?: number }> = []
  const structures: Array<{
    kind: "if" | "while" | "until" | "for" | "case"
    phase: "header" | "condition" | "pattern" | "body" | "do"
    count: number
    sawElse?: boolean
    patternStarted?: boolean
    parenthesized?: boolean
  }> = []

  const statement = () => {
    statements++
    const structure = structures.at(-1)
    if (structure) structure.count++
  }
  const header = () => ["header", "pattern", "do"].includes(structures.at(-1)?.phase ?? "")

  const finishWord = () => {
    if (!wordStarted) return
    if (!redirectTarget) {
      words.push(word)
      // Unquoted trailing continuations are ignored syntax, not part of the raw token.
      rawWords.push(input.slice(wordStart, wordEnd))
      assignmentWords.push(assignmentWord)
      commandEnd = wordEnd
    }
    redirectTarget = false
    word = ""
    wordStarted = false
    assignmentWord = false
    assignmentHeadUnsafe = false
  }

  const finishCommand = (boundary = false) => {
    finishWord()
    if (redirectTarget) invalidRedirect = true
    redirectTarget = false
    if (compoundEnd && words.length > 0) invalidStructure = true
    const resource = input.slice(segment, resourceEnd ?? wordEnd).replace(/^[ \t\n]+|[ \t\n]+$/g, "")
    const name = assignmentWords.findIndex((assignment) => !assignment)
    if (name >= 0 && !words[name]) invalidStructure = true
    if (rawWords.includes("}")) invalidStructure = true
    if (resource && name >= 0 && !header()) {
      const command: Command = {
        resource,
        words: words.slice(name),
        rawWords: rawWords.slice(name),
        ...(name === 0 && BASH_DECLARATIONS.has(rawWords[0]) && resource.startsWith(rawWords[0])
          ? { declaration: true as const }
          : {}),
        ...(redirectWordCount !== undefined && redirectWordCount < words.length
          ? { redirectWordCount: redirectWordCount - name }
          : {}),
      }
      commands.push(command)
      if (resourceEnd === undefined) {
        for (const heredoc of heredocs) {
          if (heredoc.command) continue
          heredoc.command = command
          heredoc.start = segment
        }
      }
    }
    if ((!resource || name < 0) && !header() && !compoundEnd && (hasRedirect || boundary || separated)) {
      const assignmentOnly = assignmentWords.length > 0 && assignmentWords.every(Boolean)
      if (!assignmentOnly && !hasRedirect) invalidStructure = true
    }
    commands.push(...nestedCommands.splice(0))
    if (!header() && (words.length > 0 || hasRedirect || assignmentWords.length > 0)) statement()
    words.length = 0
    rawWords.length = 0
    assignmentWords.length = 0
    separated = true
    hasRedirect = false
    resourceEnd = undefined
    redirectWordCount = undefined
    compoundEnd = false
  }

  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (!wordStarted) wordStart = index
    if (!quote && !wordStarted) {
      if (char === " " || char === "\t") continue
      if (char === "\\" && input[index + 1] === "\n") {
        index++
        continue
      }
      const structure = structures.at(-1)
      if (
        char === "}" &&
        words.length === 0 &&
        !redirectTarget &&
        (close === "}" || close === "nofork") &&
        structures.length === 0 &&
        heredocs.length === 0 &&
        (close === "nofork" || /^(?:\\\n)*(?:[ \t\n;&|()<>]|$)/.test(input.slice(index + 1, index + 32)))
      ) {
        if (hasRedirect || compoundEnd) {
          finishCommand()
          dangling = false
        }
        if (dangling || invalidStructure || !statements) return { kind: "opaque", reason: "invalid-structure" }
        if (invalidRedirect) return { kind: "opaque", reason: "invalid-redirect" }
        return { kind: "scanned", commands, end: index }
      }
      if (char === "}") return { kind: "opaque", reason: structures.length ? "compound-command" : "invalid-structure" }
      const token =
        (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_"
          ? ((TOKEN_RE.lastIndex = index), TOKEN_RE.exec(input)?.[0])
          : undefined
      if (structure?.kind === "case" && structure.phase === "header" && token === "in") {
        if (words.length !== 1 || hasRedirect) return { kind: "opaque", reason: "compound-command" }
        finishCommand()
        structure.phase = "pattern"
        structure.patternStarted = false
        index += token.length - 1
        segment = index + 1
        continue
      }
      if (structure?.phase === "pattern" && !structure.patternStarted && !words.length && token === "esac") {
        structures.pop()
        statement()
        compoundEnd = true
        dangling = false
        index += token.length - 1
        segment = index + 1
        inList = false
        continue
      }
      if (structure?.phase === "pattern" && !structure.patternStarted && !words.length && char === "(") {
        structure.patternStarted = true
        segment = index + 1
        continue
      }
      if (structure?.phase === "pattern" && char === "|") {
        if (!words.length) return { kind: "opaque", reason: "compound-command" }
        finishWord()
        structure.patternStarted = true
        segment = index + 1
        continue
      }
      if (structure?.phase === "pattern" && char === ")") {
        if (!words.length) return { kind: "opaque", reason: "compound-command" }
        finishCommand()
        structure.phase = "body"
        structure.count = 0
        segment = index + 1
        continue
      }
      if (structure?.kind === "for" && structure.phase === "header" && char === "(" && input[index + 1] !== "(") {
        const values = scanBashArrayOrPattern(input, index, depth + 1, budget, "array")
        if (values.kind === "opaque") return { kind: "opaque", reason: "compound-command" }
        finishCommand()
        commands.push(...values.commands)
        // Zsh permits a sublist or brace group directly after the value list, without do/done.
        structure.phase = "do"
        structure.parenthesized = true
        DO_AHEAD_RE.lastIndex = values.end + 1
        if (!DO_AHEAD_RE.test(input)) structures.pop()
        index = values.end
        segment = index + 1
        continue
      }
      if (
        token &&
        ["then", "elif", "else", "fi", "do", "done", "esac"].includes(token) &&
        !words.length &&
        !redirectTarget &&
        (!header() || (token === "do" && structure?.phase === "do"))
      ) {
        if (hasRedirect || compoundEnd) {
          finishCommand()
          dangling = false
        }
        if (!structure || dangling) return { kind: "opaque", reason: "compound-command" }
        if (token === "then") {
          if (structure.kind !== "if" || structure.phase !== "condition" || !structure.count)
            return { kind: "opaque", reason: "compound-command" }
          structure.phase = "body"
          structure.count = 0
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
        }
        if (token === "elif" || token === "else") {
          if (structure.kind !== "if" || structure.phase !== "body" || !structure.count || structure.sawElse)
            return { kind: "opaque", reason: "compound-command" }
          structure.phase = token === "elif" ? "condition" : "body"
          structure.sawElse = token === "else"
          structure.count = 0
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
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
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
        }
        if (
          (token === "fi" && (structure.kind !== "if" || structure.phase !== "body" || !structure.count)) ||
          (token === "done" &&
            (!["for", "while", "until"].includes(structure.kind) || structure.phase !== "body" || !structure.count)) ||
          (token === "esac" && (structure.kind !== "case" || structure.phase === "header"))
        )
          return { kind: "opaque", reason: "compound-command" }
        structures.pop()
        statement()
        compoundEnd = true
        dangling = false
        structure.count = 0
        index += token.length - 1
        segment = index + 1
        inList = false
        continue
      }
      if (structure?.kind === "for" && structure.phase === "do" && char !== "\n" && char !== "#" && char !== ";") {
        if (char !== "{" || !/^(?:\\\n)*[ \t\n]/.test(input.slice(index + 1, index + 16)))
          return { kind: "opaque", reason: "compound-command" }
        structures.pop()
      }
      if (!words.length && !hasRedirect && !compoundEnd) {
        const definition =
          (char >= "A" && char <= "Z") || (char >= "a" && char <= "z") || char === "_" || char === "("
            ? ((FUNCTION_HEAD_RE.lastIndex = index), FUNCTION_HEAD_RE.exec(input)?.[0])
            : undefined
        if (definition && !header()) {
          index += definition.length - 1
          segment = index + 1
          continue
        }
        if (
          !header() &&
          (token === "if" ||
            token === "while" ||
            token === "until" ||
            token === "for" ||
            token === "select" ||
            token === "case")
        ) {
          if (depth + structures.length >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "compound-command" }
          structures.push({
            kind: token === "select" ? "for" : token,
            phase: ["for", "select", "case"].includes(token) ? "header" : "condition",
            count: 0,
          })
          index += token.length - 1
          segment = index + 1
          inList = false
          continue
        }
        if (
          !header() &&
          ((char === "!" && /^(?:\\\n)*[ \t\n(]/.test(input.slice(index + 1, index + 16))) ||
            (token === "coproc" &&
              /^coproc[ \t]+(?:[A-Za-z_][A-Za-z0-9_]*[ \t]+)?(?:[{(]|(?:if|while|until|for|case)\b)/.test(
                input.slice(index, index + 128),
              )) ||
            (token === "time" &&
              /^time[ \t]+(?:-p[ \t]+)?(?:[{(]|(?:if|while|until|for|case)\b)/.test(input.slice(index, index + 128))))
        ) {
          index += token ? token.length - 1 : 0
          if (token === "time") index += /^[ \t]+-p\b/.exec(input.slice(index + 1, index + 32))?.[0].length ?? 0
          if (token === "coproc")
            index +=
              /^[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]+(?=[{(]|(?:if|while|until|for|case)\b)/.exec(
                input.slice(index + 1, index + 128),
              )?.[0].length ?? 0
          segment = index + 1
          continue
        }
      }
      if (
        ((!words.length && !hasRedirect && !compoundEnd && !header()) ||
          (structure?.kind === "for" && structure.phase === "header")) &&
        input.startsWith("((", index)
      ) {
        const forHeader = structure?.kind === "for" && structure.phase === "header"
        if (forHeader && words.length > 0) return { kind: "opaque", reason: "compound-command" }
        const expression = scanBashArithmetic(input, index + 2, depth + 1, budget, forHeader)
        if (expression.kind === "scanned") {
          commands.push(...expression.commands)
          if (forHeader) {
            structure.phase = "do"
          }
          if (!forHeader) {
            statement()
            compoundEnd = true
          }
          dangling = false
          index = expression.end
          segment = index + 1
          continue
        }
        if (forHeader || expression.reason !== "not-arithmetic") return { kind: "opaque", reason: "invalid-structure" }
      }
      if (
        !words.length &&
        !hasRedirect &&
        !compoundEnd &&
        !header() &&
        (char === "(" || (char === "{" && /^(?:\\\n)*[ \t\n]/.test(input.slice(index + 1, index + 16))))
      ) {
        const groupClose = char === "{" ? "}" : ")"
        const group = scanBash(input, index + 1, depth + 1, budget, groupClose)
        if (group.kind === "opaque") return group
        if (!input.slice(index + 1, group.end).trim()) return { kind: "opaque", reason: "invalid-structure" }
        commands.push(...group.commands)
        statement()
        compoundEnd = true
        dangling = false
        index = group.end
        segment = index + 1
        continue
      }
      if (
        !words.length &&
        !hasRedirect &&
        !compoundEnd &&
        !header() &&
        input.startsWith("[[", index) &&
        /^(?:\\\n)*[ \t\n]/.test(input.slice(index + 2, index + 18))
      ) {
        const expression = scanBashConditional(input, index + 2, depth + 1, budget)
        if (expression.kind === "opaque") return expression
        commands.push(...expression.commands)
        statement()
        compoundEnd = true
        dangling = false
        index = expression.end
        segment = index + 1
        continue
      }
    }
    if (quote === "single") {
      wordStarted = true
      wordEnd = index + 1
      if (char === "'") {
        quote = undefined
        continue
      }
      word += char
      continue
    }
    if (quote === "double") {
      wordStarted = true
      if (char === '"') {
        quote = undefined
        wordEnd = index + 1
        continue
      }
      if (char === "\\" && index + 1 < input.length) {
        const next = input[index + 1]
        if ('$`"\\\n'.includes(next)) {
          index++
          if (next !== "\n") word += next
          wordEnd = index + 1
          continue
        }
        word += char
        wordEnd = index + 1
        continue
      }
      if (char === "$" && input[index + 1] === "$") {
        word += "$$"
        index++
        wordEnd = index + 1
        continue
      }
      if (char === "$" && input[index + 1] === "\\" && input[index + 2] === "\n")
        return { kind: "opaque", reason: "command-substitution" }
      if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
        const allowBracket =
          words.some((_, idx) => !assignmentWords[idx]) && !BASH_DECLARATIONS.has(rawWords[0] ?? word)
        const substitution = scanBashDollarOrBacktick(input, index, depth, budget, true, allowBracket)
        if (substitution.kind === "opaque") return substitution
        nestedCommands.push(...substitution.commands)
        word += input.slice(index, substitution.end + 1)
        index = substitution.end
        wordEnd = index + 1
        continue
      }
      word += char
      wordEnd = index + 1
      continue
    }
    if (char === "$" && input[index + 1] === "$") {
      if (input[index + 2] === "'") {
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
      wordStarted = true
      word += "$$"
      index++
      wordEnd = index + 1
      continue
    }
    if (char === "$" && input[index + 1] === "\\" && input[index + 2] === "\n")
      return { kind: "opaque", reason: "command-substitution" }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      wordStarted = true
      if (!assignmentWord) assignmentHeadUnsafe = true
      word += literal.value
      index = literal.end
      wordEnd = index + 1
      continue
    }
    if (char === "$" && input[index + 1] === '"') {
      quote = "double"
      wordStarted = true
      if (!assignmentWord) assignmentHeadUnsafe = true
      wordEnd = ++index + 1
      continue
    }
    if (char === "'") {
      quote = "single"
      wordStarted = true
      wordEnd = index + 1
      if (!assignmentWord) assignmentHeadUnsafe = true
      continue
    }
    if (char === '"') {
      quote = "double"
      wordStarted = true
      wordEnd = index + 1
      if (!assignmentWord) assignmentHeadUnsafe = true
      continue
    }
    if (char === "\\") {
      if (index + 1 >= input.length) return { kind: "opaque", reason: "unterminated-escape" }
      if (input[index + 1] === "\n") {
        index++
        continue
      }
      wordStarted = true
      if (!assignmentWord) assignmentHeadUnsafe = true
      word += input[++index]
      wordEnd = index + 1
      continue
    }
    const inCasePattern = structures.at(-1)?.phase === "pattern"
    if (inCasePattern && char === "[") {
      const bracket = scanBashPatternBracket(input, index, depth + 1, budget)
      if (bracket) {
        if (bracket.kind === "opaque") return bracket
        nestedCommands.push(...bracket.commands)
        wordStarted = true
        word += input.slice(index, bracket.end + 1)
        index = bracket.end
        wordEnd = index + 1
        continue
      }
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const allowBracket =
        !assignmentWord && words.some((_, idx) => !assignmentWords[idx]) && !BASH_DECLARATIONS.has(rawWords[0] ?? "")
      const substitution = scanBashDollarOrBacktick(input, index, depth, budget, false, allowBracket)
      if (substitution.kind === "opaque") return substitution
      nestedCommands.push(...substitution.commands)
      wordStarted = true
      word += input.slice(index, substitution.end + 1)
      index = substitution.end
      wordEnd = index + 1
      continue
    }
    if (
      char === "[" &&
      !inCasePattern &&
      !assignmentWord &&
      !assignmentHeadUnsafe &&
      words.every((_, idx) => assignmentWords[idx]) &&
      /^[A-Za-z_][A-Za-z0-9_]*$/.test(word)
    ) {
      SUBSCRIPT_ASSIGN_RE.lastIndex = index
      if (SUBSCRIPT_ASSIGN_RE.test(input)) {
        const subscript = scanBashSubscript(input, index, depth + 1, budget, false)
        if (subscript.kind === "opaque") return subscript
        nestedCommands.push(...subscript.commands)
        wordStarted = true
        word += input.slice(index, subscript.end + 1)
        index = subscript.end
        wordEnd = index + 1
        continue
      }
      if (/\]\+?=/.test(input.slice(index + 1))) return { kind: "opaque", reason: "invalid-structure" }
    }
    if (
      char === "(" &&
      ((assignmentWord && word.endsWith("=")) ||
        (/[?*+@!]$/.test(word) && (words.length > 0 || inCasePattern || assignmentWord)))
    ) {
      const mode = assignmentWord && word.endsWith("=") ? "array" : "pattern"
      const group = scanBashArrayOrPattern(input, index, depth + 1, budget, mode)
      if (group.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      nestedCommands.push(...group.commands)
      wordStarted = true
      word += input.slice(index, group.end + 1)
      index = group.end
      wordEnd = index + 1
      continue
    }
    if ((char === "<" || char === ">" || (char === "=" && !wordStarted)) && input[index + 1] === "(") {
      const substitution = scanBash(input, index + 2, depth + 1, budget, ")")
      if (substitution.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      nestedCommands.push(...substitution.commands)
      wordStarted = true
      word += input.slice(index, substitution.end + 1)
      index = substitution.end
      wordEnd = index + 1
      continue
    }
    if (char === "#" && !wordStarted) {
      const newline = input.indexOf("\n", index)
      if (words.length > 0 || hasRedirect) {
        finishCommand()
        dangling = false
        inList = false
      }
      if (newline === -1) break
      index = newline - 1
      segment = newline
      continue
    }
    const redirect = "<>&".includes(char)
      ? BASH_REDIRECTS.find((candidate) => input.startsWith(candidate, index))
      : undefined
    if (redirect) {
      if (
        input[index + redirect.length] === "\\" &&
        input[index + redirect.length + 1] === "\n" &&
        "<>&|".includes(input[index + redirect.length + 2] ?? "\0")
      )
        return { kind: "opaque", reason: "invalid-redirect" }
      hasRedirect = true
      if (redirectTarget) invalidRedirect = true
      const fdPrefix = wordStarted && !assignmentHeadUnsafe && /^(?:\d+|\{[A-Za-z_][A-Za-z0-9_]*\})$/.test(word)
      if (fdPrefix) {
        // A continuation separates the legacy number token from the redirect descriptor.
        if (wordEnd < index) commandEnd = wordEnd
        word = ""
        wordStarted = false
      }
      if (!fdPrefix) finishWord()
      // Trailing redirects wrap a whole list/pipeline in the legacy grammar, not its last command.
      // Prefix redirects remain part of the command, and later words remain redirect destinations.
      if (redirectWordCount === undefined && assignmentWords.some((assignment) => !assignment)) {
        redirectWordCount = words.length
        if (inList) resourceEnd = commandEnd
      }
      if (redirect === "<<" || redirect === "<<-") {
        const delimiter = bashHeredocDelimiter(input, index)
        if (!delimiter) return { kind: "opaque", reason: "invalid-redirect" }
        heredocs.push(delimiter)
        wordEnd = delimiter.end + 1
        index = delimiter.end
        redirectTarget = false
        continue
      }
      redirectTarget = true
      index += redirect.length - 1
      continue
    }
    if (inCasePattern && (char === ")" || char === "|")) {
      finishWord()
      index--
      continue
    }
    if (char === ")") {
      if (close !== ")" || structures.length > 0 || heredocs.length > 0)
        return { kind: "opaque", reason: "compound-command" }
      if (wordStarted || words.length > 0 || hasRedirect || compoundEnd) {
        finishCommand()
        dangling = false
      }
      if (dangling || invalidStructure) return { kind: "opaque", reason: "invalid-structure" }
      if (invalidRedirect) return { kind: "opaque", reason: "invalid-redirect" }
      return { kind: "scanned", commands, end: index }
    }
    if (char === "(") return { kind: "opaque", reason: "compound-command" }
    if (/\s/.test(char) && !" \t\n".includes(char)) return { kind: "opaque", reason: "invalid-structure" }
    if (char === " " || char === "\t") {
      finishWord()
      continue
    }
    const next = input[index + 1]
    if (
      (char === "|" || char === "&" || char === ";") &&
      next === "\\" &&
      input[index + 2] === "\n" &&
      "|&;".includes(input[index + 3] ?? "\0")
    )
      return { kind: "opaque", reason: "invalid-structure" }
    const separator =
      (char === "&" && next === "&") || (char === "|" && (next === "|" || next === "&"))
        ? char + next
        : char === ";" || char === "|" || char === "&" || char === "\n"
          ? char
          : undefined
    if (separator) {
      const structure = structures.at(-1)
      if (char === ";" && structure?.kind === "case" && structure.phase === "body" && (next === ";" || next === "&")) {
        if (dangling && !wordStarted && !words.length && !hasRedirect && !compoundEnd)
          return { kind: "opaque", reason: "invalid-structure" }
        if (wordStarted || words.length || hasRedirect || compoundEnd) {
          finishCommand()
          dangling = false
        }
        structure.phase = "pattern"
        structure.patternStarted = false
        index += input.startsWith(";;&", index) ? 2 : 1
        segment = index + 1
        inList = false
        continue
      }
      if (separator === "\n" && !wordStarted && words.length === 0 && !hasRedirect && !compoundEnd) {
        if (heredocs.length) {
          for (const heredoc of heredocs.splice(0)) {
            const body = bashHeredoc(input, index + 1, heredoc)
            if (!body) return { kind: "opaque", reason: "heredoc" }
            if (heredoc.command) heredoc.command.resource = input.slice(heredoc.start, body.end).trim()
            if (!heredoc.quoted) {
              const expansion = scanBashHeredocBody(body.source, depth + 1, budget)
              if (expansion.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
              commands.push(...expansion.commands)
            }
            index = body.end
          }
        }
        segment = index + 1
        continue
      }
      finishCommand(true)
      if (structure?.kind === "for" && structure.phase === "header") structure.phase = "do"
      dangling = separator !== "&" && separator !== ";" && separator !== "\n"
      inList = dangling
      if (separator === "\n" && heredocs.length) {
        index--
        continue
      }
      index += separator.length - 1
      segment = index + 1
      continue
    }
    wordStarted = true
    if (char === "=" && !assignmentHeadUnsafe && /^[A-Za-z_][A-Za-z0-9_]*(?:\[.*\])?\+?$/.test(word))
      assignmentWord = true
    word += char
    wordEnd = index + 1
  }

  if (close) return { kind: "opaque", reason: close === ")" ? "command-substitution" : "invalid-structure" }
  if (quote) return { kind: "opaque", reason: "unterminated-quote" }
  if (heredocs.length) return { kind: "opaque", reason: "heredoc" }
  if (wordStarted || words.length > 0 || hasRedirect) {
    finishCommand()
    dangling = false
  }
  if (dangling) invalidStructure = true
  if (invalidStructure) return { kind: "opaque", reason: "invalid-structure" }
  if (invalidRedirect) return { kind: "opaque", reason: "invalid-redirect" }
  if (structures.length) return { kind: "opaque", reason: "compound-command" }
  return { kind: "scanned", commands, end: input.length }
}

function scanBashDollarOrBacktick(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  quoted: boolean,
  allowBracket: boolean,
): BashSpanResult {
  if (depth >= MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  if (input[start] === "`") return scanBashBacktick(input, start, depth + 1, budget, quoted)
  if (input.startsWith("$((", start)) {
    const arith = scanBashArithmetic(input, start + 3, depth + 1, budget, false)
    if (arith.kind === "scanned") return arith
    if (arith.reason === "not-arithmetic") {
      const sub = scanBash(input, start + 2, depth + 1, budget, ")")
      if (sub.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      return sub
    }
    return { kind: "opaque", reason: "command-substitution" }
  }
  if (input.startsWith("$(", start)) {
    const sub = scanBash(input, start + 2, depth + 1, budget, ")")
    if (sub.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
    return sub
  }
  NOFORK_OPEN_RE.lastIndex = start
  const nofork = NOFORK_OPEN_RE.exec(input)
  if (nofork) {
    const sub = scanBash(input, start + nofork[0].length, depth + 1, budget, "nofork")
    if (sub.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
    return sub
  }
  if (input.startsWith("${", start)) return scanBashParameter(input, start + 2, depth + 1, budget, quoted)
  if (input.startsWith("$[", start)) {
    if (!allowBracket) return { kind: "opaque", reason: "command-substitution" }
    return scanBashBracketArithmetic(input, start + 2, depth + 1, budget)
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashBacktick(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  quoted: boolean,
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  let source = ""
  for (let index = start + 1; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    if (input[index] === "`") {
      const inner = scanBash(source, 0, depth, budget)
      if (inner.kind === "opaque") return { kind: "opaque", reason: "command-substitution" }
      return { kind: "scanned", commands: inner.commands, end: index }
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

function scanBashArithmetic(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  allowSemicolon: boolean,
): BashSpanResult | { kind: "opaque"; reason: OpaqueReason | "not-arithmetic" } {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "invalid-structure" }
  const commands: Command[] = []
  let parenDepth = 0
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === ")" && parenDepth === 0) {
      if (input[index + 1] === ")") return { kind: "scanned", commands, end: index + 1 }
      return { kind: "opaque", reason: "not-arithmetic" }
    }
    if (char === ")") {
      parenDepth--
      continue
    }
    if (char === "(") {
      parenDepth++
      if (depth + parenDepth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "invalid-structure" }
      continue
    }
    if (char === ";" && !allowSemicolon) return { kind: "opaque", reason: "invalid-structure" }
    if (char === "\\") {
      index++
      continue
    }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      index = literal.end
      continue
    }
    if (char === "'") {
      const single = scanBashArithmeticSingleQuote(input, index + 1, depth, budget)
      if (single.kind === "opaque") return single
      commands.push(...single.commands)
      index = single.end
      continue
    }
    if (char === '"') {
      const double = scanBashDoubleQuoteSpan(input, index + 1, depth + 1, budget, true)
      if (double.kind === "opaque") return double
      commands.push(...double.commands)
      index = double.end
      continue
    }
    if (char === "[") {
      const subscript = scanBashSubscript(input, index, depth + 1, budget, true)
      if (subscript.kind === "opaque") return subscript
      commands.push(...subscript.commands)
      index = subscript.end
      continue
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, true)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "invalid-structure" }
}

function scanBashArithmeticSingleQuote(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
): BashSpanResult {
  const commands: Command[] = []
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "'") return { kind: "scanned", commands, end: index }
    if ("()[];".includes(char)) return { kind: "opaque", reason: "invalid-structure" }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, true)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "unterminated-quote" }
}

function scanBashBracketArithmetic(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "]") return { kind: "scanned", commands, end: index }
    if (";|&<>()[\n'\"\\#".includes(char)) return { kind: "opaque", reason: "command-substitution" }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, true)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashSubscript(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  allowBracket: boolean,
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  let bracketDepth = 0
  for (let index = start + 1; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "]" && bracketDepth === 0) return { kind: "scanned", commands, end: index }
    if (char === "]") {
      bracketDepth--
      continue
    }
    if (char === "[") {
      bracketDepth++
      continue
    }
    if (char === "\\") {
      index++
      continue
    }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      index = literal.end
      continue
    }
    if (char === "'") {
      const single = scanBashArithmeticSingleQuote(input, index + 1, depth, budget)
      if (single.kind === "opaque") return single
      commands.push(...single.commands)
      index = single.end
      continue
    }
    if (char === '"') {
      const double = scanBashDoubleQuoteSpan(input, index + 1, depth + 1, budget, allowBracket)
      if (double.kind === "opaque") return double
      commands.push(...double.commands)
      index = double.end
      continue
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, allowBracket)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashParameter(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  quoted: boolean,
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "}") return { kind: "scanned", commands, end: index }
    if (char === "\\") {
      if (!quoted || '$`\\\n"'.includes(input[index + 1] ?? "\0")) index++
      continue
    }
    if (char === "$" && input[index + 1] === "$") {
      index++
      continue
    }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      index = literal.end
      continue
    }
    if (char === "'" && !quoted) {
      const end = input.indexOf("'", index + 1)
      if (end < 0) return { kind: "opaque", reason: "unterminated-quote" }
      index = end
      continue
    }
    if (char === "'" && quoted) {
      const closeQuote = input.indexOf("'", index + 1)
      if (closeQuote < 0) return { kind: "opaque", reason: "command-substitution" }
      for (let cursor = index + 1; cursor < closeQuote; cursor++) {
        if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
        const inner = input[cursor]
        if ('"}[]'.includes(inner)) return { kind: "opaque", reason: "command-substitution" }
        if ((inner === "$" && "({[".includes(input[cursor + 1] ?? "\0")) || inner === "`") {
          const nested = scanBashDollarOrBacktick(input, cursor, depth, budget, true, false)
          if (nested.kind === "opaque") return nested
          commands.push(...nested.commands)
          cursor = nested.end
        }
      }
      index = closeQuote
      continue
    }
    if (char === '"' || (char === "$" && input[index + 1] === '"')) {
      const double = scanBashDoubleQuoteSpan(input, index + (char === "$" ? 2 : 1), depth + 1, budget, false)
      if (double.kind === "opaque") return double
      commands.push(...double.commands)
      index = double.end
      continue
    }
    if (char === "[" && /^[!#]?[A-Za-z_][A-Za-z0-9_]*$/.test(input.slice(start, index))) {
      const subscript = scanBashSubscript(input, index, depth + 1, budget, false)
      if (subscript.kind === "opaque") return subscript
      commands.push(...subscript.commands)
      index = subscript.end
      continue
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, quoted, false)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashDoubleQuoteSpan(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  allowBracket: boolean,
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === '"') return { kind: "scanned", commands, end: index }
    if (char === "\\") {
      if ('$`"\\\n'.includes(input[index + 1] ?? "\0")) index++
      continue
    }
    if (char === "$" && input[index + 1] === "$") {
      index++
      continue
    }
    if (char === "$" && input[index + 1] === "\\" && input[index + 2] === "\n")
      return { kind: "opaque", reason: "command-substitution" }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, true, allowBracket)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "opaque", reason: "unterminated-quote" }
}

function scanBashConditional(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "invalid-structure" }
  const commands: Command[] = []
  let wordStarted = false
  let parenDepth = 0
  for (let index = start; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    if (char === "\\" && input[index + 1] !== undefined) {
      wordStarted = true
      index++
      continue
    }
    if (!wordStarted && input.startsWith("]]", index)) {
      if (/^(?:\\\n)*(?:[ \t\n;&|()<>]|$)/.test(input.slice(index + 2, index + 18))) {
        if (parenDepth !== 0) return { kind: "opaque", reason: "invalid-structure" }
        return { kind: "scanned", commands, end: index + 1 }
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
    if (char === "$" && input[index + 1] === "$") {
      wordStarted = true
      index++
      continue
    }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      wordStarted = true
      index = literal.end
      continue
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1)
      if (end < 0) return { kind: "opaque", reason: "unterminated-quote" }
      wordStarted = true
      index = end
      continue
    }
    if (char === '"' || (char === "$" && input[index + 1] === '"')) {
      const double = scanBashDoubleQuoteSpan(input, index + (char === "$" ? 2 : 1), depth + 1, budget, false)
      if (double.kind === "opaque") return double
      commands.push(...double.commands)
      wordStarted = true
      index = double.end
      continue
    }
    if ((char === "<" || char === ">") && input[index + 1] === "(") {
      const sub = scanBash(input, index + 2, depth + 1, budget, ")")
      if (sub.kind === "opaque") return sub
      commands.push(...sub.commands)
      wordStarted = true
      index = sub.end
      continue
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, true)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      wordStarted = true
      index = nested.end
      continue
    }
    if (char === "(") {
      parenDepth++
      wordStarted = false
      continue
    }
    if (char === ")") {
      if (parenDepth === 0) return { kind: "opaque", reason: "invalid-structure" }
      parenDepth--
      wordStarted = false
      continue
    }
    if (char === "&" || char === "|" || char === "<" || char === ">") {
      wordStarted = false
      continue
    }
    if (char === ";") return { kind: "opaque", reason: "invalid-structure" }
    wordStarted = true
  }
  return { kind: "opaque", reason: "invalid-structure" }
}

function scanBashArrayOrPattern(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
  mode: "array" | "pattern",
): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  let wordStarted = false
  for (let index = start + 1; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === ")") return { kind: "scanned", commands, end: index }
    if (char === "\\" && input[index + 1] === "\n") {
      index++
      continue
    }
    if (char === "\\" && input[index + 1] !== undefined) {
      wordStarted = true
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
    if (mode === "pattern" && char === "\n") return { kind: "opaque", reason: "command-substitution" }
    if (char === ";" || char === "&" || (mode === "array" && char === "|"))
      return { kind: "opaque", reason: "command-substitution" }
    if (char === "$" && input[index + 1] === "'") {
      const literal = bashAnsiQuote(input, index + 1)
      if (!literal) return { kind: "opaque", reason: "unterminated-quote" }
      wordStarted = true
      index = literal.end
      continue
    }
    if (char === "'") {
      const end = input.indexOf("'", index + 1)
      if (end < 0) return { kind: "opaque", reason: "unterminated-quote" }
      wordStarted = true
      index = end
      continue
    }
    if (char === '"' || (char === "$" && input[index + 1] === '"')) {
      const double = scanBashDoubleQuoteSpan(input, index + (char === "$" ? 2 : 1), depth + 1, budget, false)
      if (double.kind === "opaque") return double
      commands.push(...double.commands)
      wordStarted = true
      index = double.end
      continue
    }
    if (mode === "array" && "<>=".includes(char) && input[index + 1] === "(") {
      const sub = scanBash(input, index + 2, depth + 1, budget, ")")
      if (sub.kind === "opaque") return sub
      commands.push(...sub.commands)
      wordStarted = true
      index = sub.end
      continue
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, false)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      wordStarted = true
      index = nested.end
      continue
    }
    if (char === "(") {
      const nested = scanBashArrayOrPattern(input, index, depth + 1, budget, mode)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      wordStarted = true
      index = nested.end
      continue
    }
    if (char === "[") {
      const subscript = scanBashSubscript(input, index, depth + 1, budget, false)
      if (subscript.kind === "opaque") return subscript
      commands.push(...subscript.commands)
      wordStarted = true
      index = subscript.end
      continue
    }
    wordStarted = true
  }
  return { kind: "opaque", reason: "command-substitution" }
}

function scanBashPatternBracket(
  input: string,
  start: number,
  depth: number,
  budget: { remaining: number },
): BashSpanResult | undefined {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  let first = start + 1
  if (input[first] === "!" || input[first] === "^") first++
  for (let index = first; index < input.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = input[index]
    if (char === "]" && index > first) return { kind: "scanned", commands, end: index }
    if (char === "\n" || char === ";") return undefined
    if (char === "\\" && input[index + 1] !== undefined) {
      index++
      continue
    }
    if (char === "[" && ":=".includes(input[index + 1] ?? "\0")) {
      const marker = input[index + 1]
      const closeClass = input.indexOf(`${marker}]`, index + 2)
      if (closeClass > 0) {
        index = closeClass + 1
        continue
      }
    }
    if ((char === "$" && "({[".includes(input[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(input, index, depth, budget, false, false)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return undefined
}

function scanBashHeredocBody(source: string, depth: number, budget: { remaining: number }): BashSpanResult {
  if (depth > MAX_SUBSTITUTION_DEPTH) return { kind: "opaque", reason: "command-substitution" }
  const commands: Command[] = []
  for (let index = 0; index < source.length; index++) {
    if (--budget.remaining < 0) return { kind: "opaque", reason: "invalid-structure" }
    const char = source[index]
    if (char === "\\") {
      if ('$`\\\n"'.includes(source[index + 1] ?? "\0")) index++
      continue
    }
    if (char === "$" && source[index + 1] === "$") {
      index++
      continue
    }
    if ((char === "$" && "({[".includes(source[index + 1] ?? "\0")) || char === "`") {
      const nested = scanBashDollarOrBacktick(source, index, depth, budget, false, true)
      if (nested.kind === "opaque") return nested
      commands.push(...nested.commands)
      index = nested.end
      continue
    }
  }
  return { kind: "scanned", commands, end: source.length }
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
    const simple: Record<string, string> = {
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
    if (escaped in simple) {
      value += simple[escaped]
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

function bashHeredocDelimiter(input: string, start: number) {
  const tabs = input[start + 2] === "-"
  let delimiter = ""
  let quoted = false
  let quote: "'" | '"' | undefined
  let end = start
  let started = false
  for (let index = start + (tabs ? 3 : 2); index < input.length; index++) {
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
  for (let index = start; index <= input.length; index++) {
    if (index < input.length && input[index] !== "\n") continue
    const text = input.slice(start, index)
    line += delimiter.tabs && start === lineStart ? text.replace(/^\t+/, "") : text
    if (!delimiter.quoted && /(?<!\\)(?:\\\\)*\\$/.test(line) && index < input.length) {
      line = line.slice(0, -1)
      start = index + 1
      continue
    }
    if (line === delimiter.delimiter) {
      // Dash does not join backslash-continued delimiter lines; fail closed if a physical delimiter follows.
      if (start > lineStart && input.slice(index + 1).includes(delimiter.delimiter)) return
      return { source: input.slice(bodyStart, lineStart), end: index }
    }
    line = ""
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
