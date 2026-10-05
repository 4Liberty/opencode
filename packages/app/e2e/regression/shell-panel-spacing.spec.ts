import { expect, test } from "@playwright/test"
import { fixture, installStressSessionTabs, mockStressTimeline } from "../utils/session-fixture"
import { sessionHref, draftHref } from "../utils/app"
import { openWithDirection } from "../utils/direction"

for (const direction of ["ltr", "rtl"] as const) {
  test(`bottom mobile navigation adds no extra top panel gutter in ${direction}`, async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 })
    await mockStressTimeline(page)
    await page.addInitScript(() => {
      localStorage.setItem("settings.v3", JSON.stringify({ general: { mobileTitlebarPosition: "bottom" } }))
    })
    await openWithDirection(page, "/", direction)
    const panel = page.locator('[data-slot="home-panel"]')
    await expect(panel).toHaveCSS("--shell-top-inset", "0px")
    await expect
      .poll(async () => {
        const titlebar = await page.locator('[data-slot="titlebar-v2"]').boundingBox()
        const main = await page.getByRole("main").boundingBox()
        return titlebar && main && titlebar.y >= main.y + main.height
      })
      .toBe(true)
    await expect
      .poll(async () => {
        const bounds = await panel.boundingBox()
        const main = await page.getByRole("main").boundingBox()
        return bounds && main && bounds.y - main.y
      })
      .toBe(0)
  })

  for (const screen of ["home", "new-session", "session", "settings"] as const) {
    test(`${screen} keeps only border clearance on mobile in ${direction}`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 })
      await mockStressTimeline(page)
      if (screen === "new-session") await installStressSessionTabs(page, { draftID: "shell-spacing-draft" })
      await openWithDirection(
        page,
        screen === "home"
          ? "/"
          : screen === "new-session"
            ? draftHref("shell-spacing-draft")
            : screen === "session"
              ? sessionHref(fixture.targetID)
              : `/${screen}`,
        direction,
      )
      await expect(page.locator("html")).toHaveAttribute("dir", direction)
      const panel =
        screen === "settings"
          ? page.getByTestId("settings-screen")
          : screen === "session"
            ? page.locator('[data-slot="session-chat-panel"]')
            : screen === "new-session"
              ? page.locator('[data-component="new-session"]')
              : page.locator('[data-slot="home-panel"]')
      await expect(panel).toBeVisible()
      await expect(panel).toHaveCSS("--shell-top-inset", "0px")
      await expect
        .poll(async () => {
          const bounds = await panel.boundingBox()
          const main = await page.getByRole("main").boundingBox()
          return bounds && main && bounds.y - main.y
        })
        .toBe(0)
      await expect
        .poll(async () => {
          const bounds = await panel.boundingBox()
          const main = await page.getByRole("main").boundingBox()
          return bounds && main && { x: bounds.x - main.x, width: main.width - bounds.width }
        })
        .toEqual({ x: 1, width: 2 })

      // The existing desktop gutter must return at the responsive breakpoint.
      await page.setViewportSize({ width: 768, height: 900 })
      await expect(panel).toHaveCSS("--shell-inline-inset", "8px")
      await expect(panel).toHaveCSS("--shell-top-inset", "8px")
      if (screen === "session") return
      await expect
        .poll(async () => {
          const bounds = await panel.boundingBox()
          const main = await page.getByRole("main").boundingBox()
          return bounds && main && { x: bounds.x - main.x, width: main.width - bounds.width }
        })
        .toEqual({ x: 8, width: 16 })
    })
  }
}
