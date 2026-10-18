import { test, expect } from '@playwright/test';

// Build output has a different module graph from Vite dev; catch chunk cycles here.
test('production chunks mount React and initialize ECharts without runtime errors', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/api/v1/**', (route) => route.abort('connectionrefused'));
  const response = await page.goto('/');
  expect(response.status()).toBe(200);
  await expect(page.getByRole('heading', { name: '教室里的舒适，一目了然.' })).toBeVisible();
  await expect(page.locator('.chart-canvas svg')).toHaveCount(1);
  await expect(page.getByText('暂时无法同步最新快照')).toBeVisible();
  await page.getByRole('tab', { name: '历史查询' }).click();
  await expect(page.getByRole('heading', { name: '回看环境的每一次变化.' })).toBeVisible();
  await expect(page.locator('.chart-canvas svg')).toHaveCount(1);
  expect(errors).toEqual([]);
});
