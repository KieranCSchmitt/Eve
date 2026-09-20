import { expect, type Page } from "@playwright/test";

/** Every GUI cold launch is genuinely inactive until the person opens a space. */
export async function expectHome(page: Page): Promise<void> {
  await expect(page.getByTestId("home")).toBeVisible();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.eve.snapshot()).activeTaskId),
    )
    .toBeNull();
}

export async function openInitialSpace(
  page: Page,
  title = "Orbit",
): Promise<void> {
  await expectHome(page);
  const taskId = await page.evaluate(async (title) => {
    const task = (await window.eve.snapshot()).tasks.find(
      (task) => task.title === title,
    );
    if (!task)
      throw new Error(`The requested Home card does not exist: ${title}`);
    return task.id;
  }, title);
  await page
    .getByTestId("home")
    .getByRole("button", { name: `Open ${title}`, exact: true })
    .click();
  await expect
    .poll(() =>
      page.evaluate(async () => (await window.eve.snapshot()).activeTaskId),
    )
    .toBe(taskId);
  await expect(page.getByTestId("home")).toHaveCount(0);
}
