import { expect, test } from '@playwright/test';

/**
 * Navigation sheets must stay inside the visual viewport on iPhone.
 * This is a regression test for Tailwind v4's independent translate property.
 */
test('mobile workspace menu opens as a bottom sheet inside the viewport', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('iphone'), 'Mobile-only navigation');

  await page.goto('/');
  await page.getByRole('button', { name: 'Mais páginas' }).click();

  const dialog = page.getByRole('dialog', { name: 'Seu workspace' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('navigation', { name: 'Todas as páginas' })).toBeVisible();

  const viewport = page.viewportSize();
  const bounds = await dialog.boundingBox();
  expect(viewport).not.toBeNull();
  expect(bounds).not.toBeNull();
  if (!viewport || !bounds) return;

  // No half-screen X/Y offset, including in iOS WebKit.
  expect(Math.abs(bounds.x)).toBeLessThanOrEqual(3);
  expect(Math.abs(bounds.width - viewport.width)).toBeLessThanOrEqual(3);
  expect(bounds.y).toBeGreaterThanOrEqual(-3);
  expect(Math.abs(bounds.y + bounds.height - viewport.height)).toBeLessThanOrEqual(4);

  await dialog.getByRole('link', { name: 'Configurações' }).click();
  await expect(dialog).toBeHidden();
  await expect(page).toHaveURL(/\/settings(?:$|[?#])/);
});
