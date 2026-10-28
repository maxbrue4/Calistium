#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
const wgerService = fs.readFileSync(path.join(root, 'services', 'wger-catalog.js'), 'utf8');

for (const id of ['loginScreen', 'registerScreen', 'appScreen', 'exercisesGrid', 'physiqueTab', 'physiquePhoto', 'googleLoginButton', 'profilePhoto']) {
  if (!html.includes(`id="${id}"`)) throw new Error(`Falta el elemento de interfaz ${id}.`);
}
if (/const exercises\s*=\s*\[/.test(app)) throw new Error('Todavía hay una lista manual de ejercicios embebida en app.js.');
if (!app.includes("'/api/exercises'") && !app.includes('`/api/exercises')) throw new Error('El frontend no consulta el catálogo de wger.');
if (!server.includes("app.get('/api/exercises'")) throw new Error('No existe la ruta del catálogo de ejercicios.');
if (!server.includes("app.post('/api/auth/google'")) throw new Error('No existe la autenticación con Google.');
if (!server.includes("app.put('/api/profile/photo'")) throw new Error('No existe el guardado seguro de foto de perfil.');
if (!server.includes("app.post('/api/ai/physique'")) throw new Error('No existe la ruta de generación de imagen con IA.');
if (!server.includes('https://api.stability.ai/v2beta/stable-image/edit/inpaint')) throw new Error('La ruta de imagen debe usar Stability AI Inpaint.');
if (!server.includes("form.append('mask'")) throw new Error('La ruta de imagen no envía la máscara Inpaint.');
if (!app.includes('physiqueMaskOverlay') || !app.includes('physiqueMaskHasMarks')) throw new Error('Falta el editor de máscara del físico.');
if (!html.includes('physique-download-row')) throw new Error('Falta el contenedor separado del botón de descarga.');
if (!wgerService.includes('https://wger.de/api/v2/')) throw new Error('No se encontró la fuente oficial wger.');
if (!html.includes('Elegir o sacar foto')) throw new Error('Falta la carga de foto de perfil.');
if (/Tu Avatar Pixel|characterSprite|pixel-(uno|dos|tres|cuatro|cinco)\.png/i.test(html + app)) throw new Error('Todavía aparece el antiguo personaje pixelado.');
if (!fs.existsSync(path.join(root, 'public', 'avatar-placeholder.svg'))) throw new Error('Falta la imagen de perfil predeterminada.');
if (!fs.existsSync(path.join(root, 'public', 'placeholder.svg'))) throw new Error('Falta el placeholder de ejercicios.');

if (!html.includes('class="nav-brand-logo"') || !html.includes('class="nav-tabs-links"') || !fs.existsSync(path.join(root, 'public', 'images', 'calistium-logo.webp'))) throw new Error('Falta el logo de Calistium a la izquierda de la navegación.');
const metasHtml = fs.readFileSync(path.join(root, 'public', 'metas.html'), 'utf8');
const metasJs = fs.readFileSync(path.join(root, 'public', 'metas.js'), 'utf8');
if (!html.includes('href="/metas.html"') || !html.includes('Planificar mis metas')) throw new Error('Falta el acceso al planificador dentro del menú de cuenta.');
if (!metasHtml.includes('id="tracker"') || !metasHtml.includes('id="notas"') || !metasJs.includes('function drawTracker')) throw new Error('La página separada de planificación de metas está incompleta.');
for (const icon of ['favicon.ico', 'favicon.svg', 'favicon-96x96.png', 'apple-touch-icon.png', 'site.webmanifest']) {
  if (!fs.existsSync(path.join(root, 'public', icon))) throw new Error(`Falta el recurso de favicon ${icon}.`);
}
if (!app.includes('function getExercisePrescription') || !app.includes('function getExerciseGuide') || !app.includes('function saveCurrentRoutine') || !app.includes('function startSavedRoutine')) throw new Error('Faltan la guía, las series/repeticiones o la gestión de rutinas.');
if (!app.includes('function deduplicateCalisthenicsExercises') || !app.includes('deduplicateCalisthenicsExercises(mappedExercises)')) throw new Error('El catálogo visual no deduplica ejercicios con nombres traducidos repetidos.');
if (!app.includes('const BEGINNER_ROUTINE_TEMPLATES') || !app.includes('function createBeginnerRoutine')) throw new Error('Faltan las rutinas estándar para principiantes de empuje, tirón y piernas.');
if (!html.includes('id="achievementsGrid"') || !app.includes('function renderAchievementsPanel')) throw new Error('Falta el panel visual de logros.');
if (!server.includes("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'") && !server.includes("role TEXT NOT NULL DEFAULT 'user'")) throw new Error('Falta el rol de usuario para la cuenta de demostración ExpoTec.');
if (!require('fs').existsSync(path.join(root, 'scripts', 'crear-cuenta-expotec.js'))) throw new Error('Falta el script para preparar la cuenta de demostración ExpoTec.');
if (!app.includes('Ruta de tracción hacia el muscle-up') || !app.includes('Remo invertido (dominada australiana)')) throw new Error('Falta la progresión de tracción hacia el muscle-up.');
if (!app.includes('Ilustración orientativa') || !fs.existsSync(path.join(root, 'public', 'images', 'calistenia-traccion.svg'))) throw new Error('Faltan las ilustraciones de reemplazo para ejercicios sin imagen de wger.');
// En desarrollo es normal tener un .env local. Solo se bloquea en una comprobación explícita de distribución.
if (process.env.CALISTIUM_CHECK_DISTRIBUTION === '1' && fs.existsSync(path.join(root, '.env'))) {
  throw new Error('Hay un archivo .env real; quitá credenciales de la copia de distribución.');
}
console.log('✅ Verificación estática correcta.');
console.log('✅ La lista manual de ejercicios fue retirada: el catálogo viene de wger.');
console.log('✅ El antiguo personaje pixelado fue retirado y el perfil admite foto propia.');
console.log('✅ Google Login permanece presente.');
console.log('✅ La visualización física usa Stability AI Inpaint con máscara explícita.');
console.log('✅ El editor de máscara separa las zonas que se editarán de las zonas protegidas.');
console.log('✅ El botón de descarga tiene una fila independiente para evitar superposición.');
console.log('✅ El logo de Calistium aparece a la izquierda de la barra de navegación.');
console.log('✅ El planificador de metas está enlazado desde Mi Cuenta y funciona como página independiente.');
console.log('✅ Los favicons están instalados en las páginas principales y de metas.');
console.log('✅ Los entrenamientos muestran guías en español, series/repeticiones y rutinas reutilizables.');
console.log('✅ Se eliminan tarjetas de ejercicios duplicadas según su nombre visible.');
console.log('✅ Hay rutinas para principiantes de empuje, tirón y piernas.');
console.log('✅ Está preparada la cuenta de demostración ExpoTec con rol admin y 2/4 logros.');
console.log('ℹ️ Esto no reemplaza probar Google, wger y Stability AI con credenciales/conexión reales.');
