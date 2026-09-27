export * as SessionMessageRow from "./message-row.js"

import { Schema } from "effect"
import { SessionMessage } from "./message.js"
import type { SessionMessageTable } from "./sql.js"

type Row = Pick<typeof SessionMessageTable.$inferSelect, "id" | "type" | "data">

const decodeSync = Schema.decodeUnknownSync(SessionMessage.Info)
const decodeUnknown = Schema.decodeUnknownEffect(SessionMessage.Info)
const encodeSync = Schema.encodeSync(SessionMessage.Info)

const fields = (row: Row) => ({ ...row.data, id: row.id, type: row.type })

/** Decodes a stored message row, throwing when the stored data is invalid. */
export const decode = (row: Row) => decodeSync(fields(row))

export const decodeEffect = (row: Row) => decodeUnknown(fields(row))

/** Splits a message into its row identity, type, and JSON data columns. */
export const encode = (message: SessionMessage.Info) => {
  const encoded = encodeSync(message)
  const { id, type, ...data } = encoded
  return { id: SessionMessage.ID.make(id), type, data }
}
