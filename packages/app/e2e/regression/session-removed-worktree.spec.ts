import { expect, test } from "@playwright/test"
import { base64Encode } from "@opencode/util/encode"
import { fixture } from "../smoke/session-timeline.fixture"
import { mockOpenCodeServer } from "../utils/mock-server"
import { installSseTransport } from "../utils/sse-transport"

test("keeps a session in a removed worktree readable and movable", async ({ page }) => {
  const missing = "/projects/removed-worktree"
  const destination = fixture.directory
  const sessionID = "ses_removed_worktree"
  const session = { id: sessionID, projectID: fixture.project.id, directory: missing, title: "Removed worktree" }
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
  await page.route("**/api/**", (route) => {
    const url = new URL(route.request().url())
    if (url.searchParams.get("location[directory]") !== missing) return route.fallback()
    if (!["/api/location", "/api/agent", "/api/provider", "/api/model", "/api/model/default"].includes(url.pathname))
      return route.fallback()
    return route.fulfill({ status: 500, body: "", headers: { "access-control-allow-origin": "*" } })
  })
  await page.route(`**/api/session/${sessionID}/move`, (route) => route.fulfill({ status: 204, body: "" }))

  await page.goto(`/server/${base64Encode(fixture.serverKey)}/session/${sessionID}`, { waitUntil: "domcontentloaded" })
  await expect(page.getByText("Saved conversation in removed worktree", { exact: true })).toBeVisible()
  const prompt = page.getByRole("textbox", { name: "Prompt", exact: true })
  await expect(prompt).toBeEditable()
  await expect(page.locator('[data-action="composer-model"]')).toContainText("Claude Opus 4.6")
  await prompt.fill("Keep the draft while moving")
  await expect(prompt).toHaveText("Keep the draft while moving")
  await transport.waitForConnection()
  await page.getByRole("button", { name: "Session details" }).click()
  await page.getByRole("button", { name: "Local repository" }).click()
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
  await expect(prompt).toHaveText("Keep the draft while moving")
  await expect(page.getByText("Saved conversation in removed worktree", { exact: true })).toBeVisible()
})
