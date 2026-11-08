import { test, expect } from "@playwright/test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

test("opening source HTML directly shows launch instructions instead of a blank page", async ({
  page,
}) => {
  await page.goto(pathToFileURL(resolve("index.html")).href);
  await expect(
    page.getByRole("heading", { name: "Gradia の起動" }),
  ).toBeVisible();
  await expect(
    page.getByText("Start-Preview.cmd", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Gradia の画面を開く" }),
  ).toHaveAttribute("href", "http://127.0.0.1:1420");
});
test("reading, translation slider, original reveal and chat context", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await expect(page.getByText("自分の知識にする。")).toBeVisible();
  await page.getByRole("button", { name: "サンプルを開く" }).click();
  await expect(page.locator(".article h1")).toHaveText(
    "Understanding ownership",
  );
  const slider = page.getByRole("slider", { name: "日本語の割合" });
  await slider.fill("100");
  await expect(page.locator('[data-translated="true"]')).not.toHaveCount(0);
  await expect(
    page.locator("article").getByText("Rustのすべての値には所有者がいる。"),
  ).toBeVisible();
  const total = await page.locator('[data-translated="true"]').count();
  await slider.fill("50");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(
    Math.round(total / 2),
  );
  expect(
    await page
      .locator(".article [data-segment]:not(.code-block)")
      .evaluateAll((nodes) =>
        nodes
          .filter((n) => n.getAttribute("data-segment") !== "b5s0")
          .map((n) => n.getAttribute("data-translated") === "true"),
      ),
  ).toEqual([
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
    false,
    true,
  ]);
  const half = await page
    .locator('[data-translated="true"]')
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-segment")));
  await slider.fill("80");
  await slider.fill("50");
  expect(
    await page
      .locator('[data-translated="true"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-segment"))),
  ).toEqual(half);
  const bilingual = page.getByRole("switch", { name: "英語と日本語を併記" });
  await bilingual.click();
  await expect(bilingual).toBeChecked();
  await expect(slider).toHaveCount(0);
  await expect(page.locator(".bilingual-translation")).toHaveCount(total);
  const owner = page.locator('[data-segment="b3s0"]');
  await expect(owner).toContainText("Every value in Rust has an owner.");
  await expect(owner).toContainText("Rustのすべての値には所有者がいる。");
  await expect(page.locator(".segment.code")).toContainText(
    'let message = String::from("Hello, world!");',
  );
  await page.screenshot({ path: "test-results/bilingual.png", fullPage: true });
  await bilingual.click();
  await expect(bilingual).not.toBeChecked();
  await expect(slider).toHaveValue("50");
  expect(
    await page
      .locator('[data-translated="true"]')
      .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("data-segment"))),
  ).toEqual(half);
  await slider.fill("0");
  await expect(page.locator('[data-translated="true"]')).toHaveCount(0);
  await page.getByRole("textbox", { name: "本文を検索" }).fill("owner");
  await expect(page.locator(".search-results button").first()).toBeVisible();
  await page.locator(".search-results button").first().click();
  await expect(page.locator(".segment.flash")).toBeVisible();
  await page
    .getByRole("button", { name: "この部分をわかりやすく説明して" })
    .click();
  await expect(
    page.getByRole("textbox", { name: "質問", exact: true }),
  ).toHaveValue("この部分をわかりやすく説明して");
  await expect(page.getByRole("button", { name: "質問を送信" })).toBeDisabled();
  await slider.fill("100");
  await page.locator(".reader-scroll").evaluate((el) => (el.scrollTop = 0));
  await page.screenshot({ path: "test-results/reader.png", fullPage: true });
  expect(errors).toEqual([]);
});
test("settings and empty state", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "設定", exact: true }).click();
  await expect(
    page.getByRole("dialog", { name: "設定", exact: true }),
  ).toBeVisible();
  await expect(
    page.getByPlaceholder("plamo-3-translate-2b-Q4_K_M.gguf"),
  ).toBeVisible();
  await page.getByRole("button", { name: "設定を閉じる" }).click();
  await page.screenshot({ path: "test-results/welcome.png" });
});
