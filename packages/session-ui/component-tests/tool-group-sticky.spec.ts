import { expect, story } from "../../storybook/playwright/story"

story("keeps the open Used header below the session title fade while scrolling", async ({ mount }) => {
  const root = await mount("current-tool-group--sticky-header", { args: { height: "720" } })
  const scroller = root.locator('[data-story="sticky-header-scroll"]')
  const header = root.getByRole("button", { name: "Used 37 Write, Shell, Grep, Edit", exact: true })
  const top = (locator: typeof header) =>
    locator.evaluate((node) => {
      const scroller = node.closest('[data-story="sticky-header-scroll"]')!
      return node.getBoundingClientRect().top - scroller.getBoundingClientRect().top
    })
  // The cover fills the faded strip between the session title and a stuck header.
  const cover = (locator: typeof header) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node, "::before")
      return style.display === "none" ? "none" : style.height
    })

  expect(await scroller.evaluate((node) => node.scrollHeight > node.clientHeight * 2)).toBe(true)
  await expect(header).toHaveAttribute("aria-expanded", "true")
  expect(await cover(header)).toBe("none")
  await scroller.evaluate((node) => (node.scrollTop = 900))
  await expect.poll(() => top(header)).toBe(64)
  await expect.poll(() => cover(header)).toBe("16px")

  // Nested file headers stack below the stuck Used header instead of covering it.
  const file = root.locator('[data-component="sticky-accordion-header"]').filter({ hasText: "model.ts" })
  await file.evaluate((node) => {
    const scroller = node.closest<HTMLElement>('[data-story="sticky-header-scroll"]')!
    scroller.scrollTop += node.getBoundingClientRect().top - scroller.getBoundingClientRect().top + 60
  })
  await expect.poll(() => top(header)).toBe(64)
  await expect.poll(() => top(file)).toBe(100)
  await expect.poll(() => cover(file)).toBe("0px")

  await header.click()
  await expect(header).toHaveAttribute("aria-expanded", "false")
  await expect.poll(() => top(header)).toBe(64)
  await expect.poll(() => cover(header)).toBe("none")
  await expect(root.locator('[data-slot="context-tool-group-item"]')).toHaveCount(0)
})
