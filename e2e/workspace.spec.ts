import { expect, test } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@rimco.test';
const adminPassword = process.env.E2E_ADMIN_PASSWORD;
if (!adminPassword) throw new Error('E2E_ADMIN_PASSWORD doit être préparé par le setup global Playwright.');
const creatorEmail = process.env.E2E_CREATOR_EMAIL ?? 'collaborateur@rimco.test';
const testUserPassword = adminPassword;

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL('/', { timeout: 10_000 });
}

test('connexion administrateur puis accès au studio de création',async({page})=>{await signIn(page,adminEmail,adminPassword);await expect(page).toHaveURL('/');await expect(page.getByRole('heading',{name:'De la demande au MP4, en quelques minutes'})).toBeVisible();await page.getByRole('link',{name:'Créer une vidéo'}).click();await expect(page.getByRole('heading',{name:'Créer une vidéo'})).toBeVisible();await expect(page.getByLabel('Décrivez votre vidéo')).toBeVisible();await expect(page.getByRole('heading',{name:'Véhicule de référence'})).toBeVisible()});

test('collaborateur génère, visionne et télécharge la vidéo simulée',async({page})=>{
 test.setTimeout(90_000);
 await signIn(page, creatorEmail, testUserPassword);
 await page.goto('/studio');
 await page.getByLabel('Décrivez votre vidéo').fill('Un Haval H6 bleu roule doucement dans le Plateau à Abidjan.');
 await expect(page.getByText('Haval H6')).toBeVisible();
 await page.getByRole('button',{name:/Générer ma vidéo/}).click();
 await expect(page.getByText('Votre vidéo est prête à consulter.')).toBeVisible({timeout:65_000});
 await page.getByRole('link',{name:'Voir ma vidéo'}).click();
 await page.goto('/bibliotheque');
 await expect(page.locator('video[aria-label^="Aperçu de"]').first()).toBeVisible();
 const download=page.waitForEvent('download');
 await page.getByRole('link',{name:'Télécharger'}).first().click();
 await expect(await download).toBeTruthy();
});
