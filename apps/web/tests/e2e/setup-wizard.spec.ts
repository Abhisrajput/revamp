import { test, expect } from "@playwright/test";

test("setup wizard — token → admin → skip IdP", async ({ page, request }) => {
  const resetRes = await request.post("/api/test/reset-setup");
  expect(resetRes.ok()).toBe(true);
  const { token } = (await resetRes.json()) as { token: string };
  expect(token).toBeTruthy();

  await page.goto("/setup");
  await page.fill("input", token);
  await page.click("button:has-text('Continue')");

  await expect(page.locator("h2")).toContainText(/Step 1|realm admin/i);
  await page.fill("input[type='email']", "admin@example.com");
  await page.fill("input[type='password']", "adminpwd123");
  await page.fill("input[placeholder='first name']", "Admin");
  await page.fill("input[placeholder='last name']", "User");
  await page.click("button:has-text('Create admin')");

  await expect(page.locator("h2")).toContainText(/identity provider|Step 2/i);
  await page.click("button:has-text('Skip')");

  await expect(page.locator("body")).not.toContainText(/error|failed/i);
});
