import { expect, test } from "@playwright/test";

test("demo UI and Supabase setup guidance work at this screen size", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Ready for the prompt." })).toBeVisible();
  await expect(page.getByText("Supabase backend", { exact: true })).toBeVisible();
  await expect(page.getByTestId("supabase-status")).toContainText(/Supabase configured\.|Supabase not configured yet\./);
  await page.getByRole("button", { name: "Check local app" }).click();
  await expect(page.getByRole("status").filter({ hasText: "App server is responding." })).toContainText("Cloud connections are not checked.");
  const fits = await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
  expect(fits).toBe(true);
});
