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
  await expect(page.getByRole('heading', { name: 'Router Controls' })).toBeVisible();

  const dock = page.getByTestId('control-dock');
  await expect(dock).toBeVisible();
  await dock.getByRole('button', { name: '2x' }).click();
  await expect(dock.getByRole('button', { name: '2x' })).toHaveClass(/selected/);
});

test('shows router edit controls without a URL change', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start' }).click();
  await page.getByRole('button', { name: /Router & Gateway/i }).click();

  await expect(page.getByRole('heading', { name: 'Router Controls' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Hue' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Vinh' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Fixed' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mobility' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Update' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Verify' })).toBeVisible();

  await page.locator('.node-toolbar select').selectOption('42');
  await expect(page.getByRole('heading', { name: 'Router Controls' })).toBeVisible();
  await page.getByLabel('router shortcuts').getByRole('button', { name: 'CanTho' }).click();
  await expect(page.getByRole('button', { name: 'Fixed' })).toBeVisible();
});
