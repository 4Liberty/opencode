import type { EffectDrizzleSqlite } from "../database/drizzle.js"
import { isNotNull, isNull, ne, or } from "drizzle-orm"
import { sqliteTable, text, integer, primaryKey } from "drizzle-orm/sqlite-core"
import { absoluteArrayColumn, absoluteColumn } from "../database/path.js"
import { Timestamps } from "../database/schema.sql.js"
import type { AbsolutePath } from "@opencode/schema/schema"
import type { Project } from "../project.js"

type DatabaseClient = EffectDrizzleSqlite.EffectSQLiteDatabase
type Transaction = Parameters<Parameters<DatabaseClient["transaction"]>[0]>[0]

export const ProjectTable = sqliteTable("project", {
  id: text().$type<Project.ID>().primaryKey(),
  worktree: absoluteColumn().notNull(),
  vcs: text().$type<Project.Vcs["type"]>(),
  name: text(),
  icon_url: text(),
  icon_url_override: text(),
  icon_color: text(),
  ...Timestamps,
  time_initialized: integer(),
  time_active: integer()
    .notNull()
    .default(0)
    .$defaultFn(() => Date.now()),
  sandboxes: absoluteArrayColumn().notNull(),
  commands: text({ mode: "json" }).$type<{ start?: string }>(),
})

/** @deprecated Use WorktreeTable from worktree/sql instead. */
export const ProjectDirectoryTable = sqliteTable(
  "project_directory",
  {
    project_id: text()
      .$type<Project.ID>()
      .notNull()
      .references(() => ProjectTable.id, { onDelete: "cascade" }),
    directory: absoluteColumn().notNull(),
    type: text().$type<"main" | "root" | "git_worktree">(),
    strategy: text(),
    time_created: integer()
      .notNull()
      .$default(() => Date.now()),
  },
  (table) => [primaryKey({ columns: [table.project_id, table.directory] })],
)

export function upsertProject(
  db: DatabaseClient | Transaction,
  project: { readonly id: Project.ID; readonly canonical: AbsolutePath; readonly vcs?: Project.Vcs },
) {
  const vcs = project.vcs?.type
  return db
    .insert(ProjectTable)
    .values({ id: project.id, worktree: project.canonical, vcs, sandboxes: [] })
    .onConflictDoUpdate({
      target: ProjectTable.id,
      set: { vcs: vcs ?? null },
      setWhere: vcs ? or(isNull(ProjectTable.vcs), ne(ProjectTable.vcs, vcs)) : isNotNull(ProjectTable.vcs),
    })
    .run()
}
