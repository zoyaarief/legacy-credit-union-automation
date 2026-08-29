import { expect, test, type Page } from "@playwright/test";

async function openReadyConsole(page: Page) {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Computer-Use Control Plane" })).toBeVisible();
  await expect(page.getByTitle("Legacy credit union member portal")).toHaveAttribute("src", /\/legacy\?embedded=1/);
  await expect(page.locator(".history-status span")).not.toHaveText("loading");
}

test("unsupported goals are rejected before discovery acts", async ({ page }) => {
  await openReadyConsole(page);
  await page.getByLabel("Goal").fill("Terminate the member savings account and report its balance and status.");
  await page.getByRole("button", { name: "Discover capability" }).click();

  await expect(page.locator(".discovery-result .failure-result strong")).toHaveText("unsupported_goal");
  await expect(page.locator(".discovery-result")).toContainText("supports only a read-only member savings balance");
  await expect(page.locator(".event-log")).toContainText("This discovery policy supports only");
});

test("discovery pauses for a human and resumes in the same target session", async ({ page }) => {
  await openReadyConsole(page);
  await page.getByLabel("Invocation input").fill("31415");
  await page.getByRole("button", { name: "Discover capability" }).click();

  await expect(page.locator(".discovery-result .intervention-card")).toContainText("operator_acknowledgment_required");
  await page.getByRole("button", { name: "Accept discovery control" }).click();
  await page.frameLocator('iframe[title="Legacy credit union member portal"]').getByRole("button", { name: "Continue lookup" }).click();
  await expect(page.getByRole("button", { name: "Resume discovery" })).toBeEnabled();
  await page.getByRole("button", { name: "Resume discovery" }).click();

  await expect(page.locator(".discovery-result .success-result strong")).toHaveText("get_savings_balance");
  await expect(page.locator(".event-log")).toContainText("Human returned control");
  await expect(page.locator(".event-log")).toContainText("DOM-derived locator candidates");
  await expect(page.locator(".artifact-inspector")).toContainText("1.2.0");
  await expect(page.locator(".artifact-inspector pre")).toContainText('"value": "member_number"');
  await expect(page.locator(".artifact-inspector pre")).toContainText('"value": ".savings-balance"');
  await expect(page.locator(".ownership-strip strong")).toHaveText("completed");
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
