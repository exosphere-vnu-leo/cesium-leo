import { expect, test } from '@playwright/test';

test('starts the dashboard and renders both tabs', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: /VNUSAT Gateway/i })).toBeVisible();
  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByTestId('system-dashboard')).toBeVisible();
  await expect(page.getByTestId('cesium-host').locator('canvas')).toBeVisible({ timeout: 20000 });

  await page.getByRole('button', { name: /Router & Gateway/i }).click();
  await expect(page.getByTestId('node-dashboard')).toBeVisible();
  await expect(page.locator('.quality-badge').first()).toBeVisible();

  const dock = page.getByTestId('control-dock');
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: '2x' }).click();
  await expect(dock.getByRole('button', { name: '2x' })).toHaveClass(/selected/);
});
