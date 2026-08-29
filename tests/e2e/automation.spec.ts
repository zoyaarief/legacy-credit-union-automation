import { expect, test, type Page } from "@playwright/test";

async function openReadyConsole(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Computer-Use Control Plane" })).toBeVisible();
  await expect(page.getByTitle("Legacy credit union member portal")).toHaveAttribute("src", /\/legacy\?embedded=1/);
  await expect(page.locator(".history-status span")).not.toHaveText("loading");
}

test("unsupported goals are rejected before discovery acts", async ({ page }) => {
  await openReadyConsole(page);
  await page.getByLabel("Goal").fill("Permanently close the member savings account and report its balance and status.");
  await page.getByRole("button", { name: "Discover capability" }).click();

  await expect(page.locator(".discovery-result .failure-result strong")).toHaveText("unsupported_goal");
  await expect(page.locator(".discovery-result")).toContainText("supports only a read-only member savings balance");
  await expect(page.locator(".event-log")).toContainText("This discovery policy supports only");
});

test("reviewed capability replays success and business outcomes end to end", async ({ page }) => {
  await openReadyConsole(page);
  await page.getByRole("button", { name: /Replay/ }).click();
  await expect(page.locator(".artifact-source")).toContainText("get_savings_balance@1.1.0");

  await page.getByLabel("Member ID input").fill("12345");
  await page.getByRole("button", { name: "Run capability" }).click();
  await expect(page.locator(".result-card .success-result strong")).toHaveText("$2,458.17");
  await expect(page.locator(".result-card .success-result")).toContainText("Active");
  await expect(page.locator(".event-log")).toContainText("using css:.accounts-grid tbody tr .savings-balance");
  await expect(page.locator(".event-log")).toContainText("Success checkpoint verified");

  await page.getByLabel("Member ID input").fill("00000");
  await page.getByRole("button", { name: "Run capability" }).click();
  await expect(page.locator(".result-card .outcome-result strong")).toHaveText("member_not_found");
  await expect(page.locator(".result-card .outcome-result")).toContainText("No member matched");
});
