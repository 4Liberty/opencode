import { expect, test, type Page } from "@playwright/test"
import { base64Encode } from "@opencode/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

test("keeps a session in a removed worktree readable and movable", async ({ page }) => {
  const missing = "/projects/removed-worktree"
  const sessionDirectory = `${missing}/src`
  const destination = fixture.directory
  const sessionID = "ses_removed_worktree"
  const session = {
    id: sessionID,
    projectID: fixture.project.id,
    directory: sessionDirectory,
    title: "Removed worktree",
  }
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: destination,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    pageMessages: () => ({
      items: [{ id: "msg_saved", type: "user", text: "Saved conversation in removed worktree", time: { created: 1 } }],
    }),
  })
  await removedInventory(page, missing)
  await page.route(`**/api/session/${sessionID}/move`, (route) => route.fulfill({ status: 204, body: "" }))

  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Saved conversation in removed worktree", { exact: true })).toBeVisible()
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(page.getByRole("status")).toContainText("Session location unavailable")
  await expect(page.getByRole("status")).toContainText(sessionDirectory)
  await expect(prompt).toHaveCount(0)
  await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toBeEnabled()
  await transport.waitForConnection()
  await page.getByRole("button", { name: "Choose worktree", exact: true }).click()
  const create = page.waitForRequest(
    (request) => new URL(request.url()).pathname === "/api/worktree" && request.method() === "POST",
    { timeout: 10_000 },
  )
  const move = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/session/${sessionID}/move` && request.method() === "POST",
  )
  await page.getByRole("menuitem", { name: "New worktree" }).click()
  expect((await create).postDataJSON()).toMatchObject({ projectID: fixture.project.id, from: fixture.project.worktree })
  const created = `${destination}/copy`
  expect((await move).postDataJSON()).toMatchObject({ directory: created })
  session.directory = created
  await transport.send({
    id: "evt_removed_worktree_moved",
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, location: { directory: created }, projectID: fixture.project.id },
  })
  await expect(prompt).toBeEditable()
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
  await expect(page.locator('[data-action="composer-model"]')).toContainText("Claude Opus 4.6")
  await expect(page.getByText("Saved conversation in removed worktree", { exact: true })).toBeVisible()
})

test("preserves a draft when a worktree disappears and resumes after choosing a directory", async ({ page }) => {
  const source = "/projects/draft-worktree"
  const destination = "/projects/restored"
  const sessionID = "ses_draft_recovery"
  const session = { id: sessionID, projectID: fixture.project.id, directory: source, title: "Draft recovery" }
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  let missing = false
  await mockOpenCodeServer(page, {
    directory: destination,
    project: { ...fixture.project, worktree: destination },
    provider: fixture.provider,
    sessions: [session],
    fileList: () => [],
    pageMessages: () => ({
      items: [{ id: "msg_draft", type: "user", text: "Saved draft history", time: { created: 1 } }],
    }),
  })
  await removedInventory(page, source, () => missing)
  let moves = 0
  await page.route(`**/api/session/${sessionID}/move`, (route) => {
    moves++
    if (moves === 1)
      return route.fulfill({
        status: 400,
        json: { _tag: "InvalidRequestError", message: "Destination is unavailable" },
        headers: { "access-control-allow-origin": "*" },
      })
    return route.fulfill({ status: 204, body: "" })
  })

  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("A draft to keep after moving")
  const connection = await transport.waitForConnection()
  missing = true
  await transport.close()
  await transport.waitForConnection({ after: connection.id })
  await expect(page.getByRole("status")).toContainText("Session location unavailable")
  await expect(prompt).toHaveCount(0)
  await expect(page.getByText("Saved draft history", { exact: true })).toBeVisible()

  await page.getByRole("button", { name: "Choose directory", exact: true }).click()
  const dialog = page.getByRole("dialog", { name: "Choose directory", exact: true })
  await expect(dialog.getByRole("combobox")).toBeFocused()
  await dialog.getByRole("combobox").fill(destination)
  await dialog.getByRole("combobox").press("Enter")
  await expect(dialog.locator(".directory-picker-selection")).toHaveText(destination)
  const move = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/session/${sessionID}/move` && request.method() === "POST",
  )
  await dialog.getByRole("button", { name: "Select folder", exact: true }).click()
  expect((await move).postDataJSON()).toEqual({ directory: destination })
  await expect(page.getByText("Failed to move session", { exact: true })).toBeVisible()
  await expect(page.getByRole("button", { name: "Choose directory", exact: true })).toBeEnabled()
  await expect(prompt).toHaveCount(0)
  expect(moves).toBe(1)

  await page.getByRole("button", { name: "Choose directory", exact: true }).click()
  await expect(dialog.getByRole("combobox")).toBeFocused()
  await dialog.getByRole("combobox").fill(destination)
  await dialog.getByRole("combobox").press("Enter")
  await expect(dialog.locator(".directory-picker-selection")).toHaveText(destination)
  const secondMove = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/session/${sessionID}/move` && request.method() === "POST",
  )
  await dialog.getByRole("button", { name: "Select folder", exact: true }).click()
  expect((await secondMove).postDataJSON()).toEqual({ directory: destination })
  expect(moves).toBe(2)
  session.directory = destination
  missing = false
  await transport.send({
    id: "evt_draft_recovery_moved",
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("A draft to keep after moving")
  await expect(page.getByText("Saved draft history", { exact: true })).toBeVisible()
})

test("ignores a stale missing result after the session moves", async ({ page }) => {
  const source = "/projects/old-worktree"
  const destination = "/projects/new-worktree"
  const sessionID = "ses_stale_location_read"
  const session = { id: sessionID, projectID: fixture.project.id, directory: source, title: "Moving session" }
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await removedInventory(page, source, undefined, { requested, release })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await requested.promise
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Draft in new worktree")
  await transport.waitForConnection()
  session.directory = destination
  await transport.send({
    id: "evt_stale_probe_moved",
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  release.resolve()
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("Draft in new worktree")
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
})

test("moves a removed-worktree session into an existing worktree", async ({ page }) => {
  const source = "/projects/deleted-worktree"
  const destination = "/projects/existing-worktree"
  const sessionID = "ses_existing_worktree"
  const session = { id: sessionID, projectID: fixture.project.id, directory: source, title: "Existing worktree" }
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: { ...fixture.project, sandboxes: [destination] },
    provider: fixture.provider,
    sessions: [session],
    pageMessages: () => ({ items: [] }),
  })
  await removedInventory(page, source, undefined, { destination })
  await page.route(`**/api/session/${sessionID}/move`, (route) => route.fulfill({ status: 204, body: "" }))
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await expect(page.getByRole("status")).toContainText("Session location unavailable")
  await transport.waitForConnection()
  await page.getByRole("button", { name: "Choose worktree", exact: true }).click()
  const option = page.getByRole("menuitem", { name: "existing-worktree", exact: true })
  await expect(option).toBeVisible()
  const move = page.waitForRequest(
    (request) => new URL(request.url()).pathname === `/api/session/${sessionID}/move` && request.method() === "POST",
  )
  await option.click()
  expect((await move).postDataJSON()).toEqual({ directory: destination })
  session.directory = destination
  await transport.send({
    id: "evt_existing_worktree_moved",
    type: "session.moved",
    created: 2,
    durable: { aggregateID: sessionID, seq: 1, version: 1 },
    data: { sessionID, location: { directory: destination }, projectID: fixture.project.id },
  })
  await expect(page.getByRole("textbox", { name: "Prompt", exact: true })).toBeEditable()
  await expect(page.getByText("Session location unavailable", { exact: true })).toHaveCount(0)
})

test("keeps the composer when the session directory was never a registered managed worktree", async ({ page }) => {
  const source = "/projects/unregistered-worktree"
  const sessionID = "ses_unregistered_worktree"
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [{ id: sessionID, projectID: fixture.project.id, directory: source }],
    pageMessages: () => ({
      items: [{ id: "msg_saved", type: "user", text: "Keep this session", time: { created: 1 } }],
    }),
  })
  let refreshes = 0
  await page.route("**/api/worktree/refresh", (route) => {
    refreshes++
    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
  })
  const listed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/worktree" && response.ok(),
  )
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await listed
  await expect(page.getByText("Keep this session", { exact: true })).toBeVisible()
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Keep this draft")
  await expect(prompt).toHaveText("Keep this draft")
  await expect(page.getByRole("status")).toHaveCount(0)
  expect(refreshes).toBe(0)
})

for (const phase of ["before", "refresh", "after"] as const) {
  test(`keeps the composer when the worktree ${phase} request fails with 500`, async ({ page }) => {
    const source = "/projects/registered-worktree"
    const sessionID = `ses_worktree_${phase}_failure`
    await mockOpenCodeServer(page, {
      directory: fixture.directory,
      project: fixture.project,
      provider: fixture.provider,
      sessions: [{ id: sessionID, projectID: fixture.project.id, directory: source }],
      pageMessages: () => ({ items: [{ id: "msg_saved", type: "user", text: "Keep working", time: { created: 1 } }] }),
    })
    let lists = 0
    await page.route("**/api/worktree?**", (route) => {
      if (route.request().method() !== "GET") return route.fallback()
      lists++
      if ((phase === "before" && lists === 1) || (phase === "after" && lists === 2))
        return route.fulfill({ status: 500, body: "", headers: { "access-control-allow-origin": "*" } })
      return route.fulfill({ json: [{ directory: fixture.directory }, { directory: source, strategy: "git" }] })
    })
    await page.route("**/api/worktree/refresh", (route) =>
      route.fulfill({ status: phase === "refresh" ? 500 : 204, headers: { "access-control-allow-origin": "*" } }),
    )
    const failed = page.waitForResponse(
      (response) =>
        ["/api/worktree", "/api/worktree/refresh"].includes(new URL(response.url()).pathname) &&
        response.status() === 500,
    )
    await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
    await failed
    await expect(page.getByText("Keep working", { exact: true })).toBeVisible()
    const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
    await expect(prompt).toBeEditable()
    await prompt.fill("Keep the draft")
    await expect(prompt).toHaveText("Keep the draft")
    await expect(page.getByRole("status")).toHaveCount(0)
  })
}

test("ignores a failed inventory refresh from before reconnecting", async ({ page }) => {
  const source = "/projects/reconnected-worktree"
  const sessionID = "ses_worktree_reconnect"
  const requested = Promise.withResolvers<void>()
  const release = Promise.withResolvers<void>()
  const transport = await installSseTransport(page, { server: fixture.serverKey })
  await mockOpenCodeServer(page, {
    directory: fixture.directory,
    project: fixture.project,
    provider: fixture.provider,
    sessions: [{ id: sessionID, projectID: fixture.project.id, directory: source }],
    pageMessages: () => ({
      items: [{ id: "msg_saved", type: "user", text: "Reconnect safely", time: { created: 1 } }],
    }),
  })
  await page.route("**/api/worktree?**", (route) =>
    route.fulfill({ json: [{ directory: fixture.directory }, { directory: source, strategy: "git" }] }),
  )
  let refreshes = 0
  await page.route("**/api/worktree/refresh", async (route) => {
    refreshes++
    if (refreshes === 1) {
      requested.resolve()
      await release.promise
    }
    return route.fulfill({ status: 500, body: "", headers: { "access-control-allow-origin": "*" } })
  })
  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`)
  await requested.promise
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await prompt.fill("Draft while reconnecting")
  const connection = await transport.waitForConnection()
  await transport.close()
  await transport.waitForConnection({ after: connection.id })
  const failed = page.waitForResponse(
    (response) => new URL(response.url()).pathname === "/api/worktree/refresh" && response.status() === 500,
  )
  release.resolve()
  await failed
  await expect(page.getByText("Reconnect safely", { exact: true })).toBeVisible()
  await expect(prompt).toBeEditable()
  await expect(prompt).toHaveText("Draft while reconnecting")
  await expect(page.getByRole("status")).toHaveCount(0)
})

async function removedInventory(
  page: Page,
  source: string,
  missing: () => boolean = () => true,
  options: {
    destination?: string
    requested?: PromiseWithResolvers<void>
    release?: PromiseWithResolvers<void>
  } = {},
) {
  let pruned = false
  await page.route("**/api/worktree?**", (route) => {
    if (route.request().method() !== "GET") return route.fallback()
    return route.fulfill({
      json: [
        { directory: fixture.directory },
        ...(!pruned || !missing() ? [{ directory: source, strategy: "git" }] : []),
        ...(options.destination ? [{ directory: options.destination, strategy: "git" }] : []),
      ],
      headers: { "access-control-allow-origin": "*" },
    })
  })
  await page.route("**/api/worktree/refresh", async (route) => {
    if (route.request().method() !== "POST") return route.fallback()
    options.requested?.resolve()
    await options.release?.promise
    if (missing()) pruned = true
    return route.fulfill({ status: 204, headers: { "access-control-allow-origin": "*" } })
  })
}
