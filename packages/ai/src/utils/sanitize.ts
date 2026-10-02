import { Media } from "../media.js"
import { isRecord } from "./record.js"

// Unchanged values keep their identity so Schema class instances skip re-validation; changed instances become plain records that callers re-decode.
export const sanitizeSurrogates = <T>(value: T): T => {
  if (typeof value === "string") return value.toWellFormed() as T
  if (Array.isArray(value)) return sanitizeArray(value) as T
  // Media assets carry binary or base64 payloads and a lazy byte cache; flattening them into a record would drop both.
  if (value instanceof Uint8Array || value instanceof Error || value instanceof Media.Asset) return value
  if (isRecord(value)) return sanitizeRecord(value) as T
  return value
}

const sanitizeArray = (value: ReadonlyArray<unknown>) => {
  for (let index = 0; index < value.length; index++) {
    const item = value[index]
    const next = sanitizeSurrogates(item)
    if (next !== item) return [...value.slice(0, index), next, ...value.slice(index + 1).map(sanitizeSurrogates)]
  }
  return value
}

const sanitizeRecord = (value: Record<string, unknown>) => {
  const keys = Object.keys(value)
  for (let index = 0; index < keys.length; index++) {
    const key = keys[index]
    const entry = value[key]
    const next = sanitizeSurrogates(entry)
    if (next === entry && key.isWellFormed()) continue
    return Object.fromEntries([
      ...keys.slice(0, index).map((previous) => [previous, value[previous]]),
      [key.toWellFormed(), next],
      ...keys.slice(index + 1).map((rest) => [rest.toWellFormed(), sanitizeSurrogates(value[rest])]),
    ])
  }
  return value
}
