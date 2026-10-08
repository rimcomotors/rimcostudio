import { expect, test } from '@playwright/test';

const adminEmail = process.env.E2E_ADMIN_EMAIL ?? 'admin@rimco.test';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Test-Rimco-Admin-2026!';
const creatorEmail = process.env.E2E_CREATOR_EMAIL ?? 'collaborateur@rimco.test';
const testUserPassword = adminPassword;

async function signIn(page: import('@playwright/test').Page, email: string, password: string) {
  await page.goto('/connexion');
  await page.getByLabel('Adresse e-mail').fill(email);
  await page.getByLabel('Mot de passe').fill(password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
  await expect(page).toHaveURL('/', { timeout: 10_000 });
}

test('connexion administrateur puis accès au studio de création',async({page})=>{await signIn(page,adminEmail,adminPassword);await expect(page).toHaveURL('/');await expect(page.getByRole('heading',{name:'Atelier de production'})).toBeVisible();await page.getByRole('link',{name:'Ouvrir le studio'}).click();await expect(page.getByRole('heading',{name:'Créer une vidéo'})).toBeVisible();await expect(page.getByLabel('Décrivez votre vidéo')).toBeVisible();await expect(page.getByRole('heading',{name:'Véhicule de référence'})).toBeVisible()});

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

test('admin prépare une comparaison de modèles sur une photo validée',async({page})=>{
 await signIn(page, adminEmail, adminPassword);
 await page.goto('/comparaison');
 await expect(page.getByRole('heading',{name:'Comparaison de modèles'})).toBeVisible();
 await page.getByLabel('Photo validée du véhicule').selectOption({index:0});
 await page.getByLabel('Brief commun').fill('Un véhicule RIMCO roule calmement dans le Plateau à la lumière douce.');
 await page.getByRole('checkbox',{name:/Kling 2.6 Pro/}).check();
 await page.getByRole('checkbox',{name:/Veo 3.1 Fast/}).check();
 await page.getByRole('button',{name:'Simuler la comparaison'}).click();
 await expect(page.getByRole('status')).toContainText('Aucun appel fournisseur n’a été effectué.');
 await page.getByLabel('Fidélité véhicule pour Kling 2.6 Pro').selectOption('5');
 await page.getByLabel('Réalisme pour Kling 2.6 Pro').selectOption('4');
 await page.getByLabel('Charte RIMCO pour Kling 2.6 Pro').selectOption('5');
 await page.getByRole('button',{name:'Enregistrer la note'}).first().click();
 await expect(page.getByRole('status').filter({hasText:'Évaluation enregistrée.'})).toBeVisible();
 const download = page.waitForEvent('download');
 await page.getByRole('button',{name:'Exporter CSV'}).click();
 await expect(await download).toBeTruthy();
});
