import { USER, expect, test } from "./fixtures";

// Sign in once through the real form; the other tests reuse the session.

test("sign up and sign in", async ({ page }) => {
  const signup = await page.request.post("/api/auth/signup", { data: USER });
  // A reused local server may already have the account.
  if (!signup.ok()) expect(await signup.json()).toEqual({ error: "User already exists" });

  // Signed out, the terminal sends you to the sign-in page.
  await page.goto("/");
  await expect(page).toHaveURL(/\/auth\/signin$/);

  await page.getByLabel("Email").fill(USER.email);
  await page.getByLabel("Password").fill("not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.locator(".auth-error")).toHaveText("Invalid credentials");

  await page.getByLabel("Password").fill(USER.password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.locator(".tx-root")).toBeVisible();
  // The account menu shows who is signed in.
  await expect(page.locator(".tx-cell .tx-legend-symbol")).toBeVisible();

  await page.context().storageState({ path: "e2e/.run/user.json" });
});
