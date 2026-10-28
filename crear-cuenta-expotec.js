#!/usr/bin/env node
// Prepara la cuenta de Google indicada en EXPO_ADMIN_EMAIL para una demo de ExpoTec.
// No crea una contraseña conocida: si la cuenta aún no existe, almacena un hash aleatorio
// inutilizable y Google la vinculará por el email verificado al iniciar sesión.
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const dotenv = require('dotenv');
const ROOT = path.resolve(__dirname, '..');
dotenv.config({ path: path.join(ROOT, '.env') });

const email = String(process.env.EXPO_ADMIN_EMAIL || '').trim().toLowerCase();
const nameFromEnv = String(process.env.EXPO_ADMIN_NAME || 'Administrador ExpoTec').trim().slice(0, 100);
const dbPath = process.env.DB_PATH || path.join(ROOT, 'evoself.db');

if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Falta EXPO_ADMIN_EMAIL en el archivo .env. Indicá el email de Google que vas a usar en ExpoTec.');
  process.exit(1);
}

const db = new sqlite3.Database(dbPath);
const run = (sql, params = []) => new Promise((resolve, reject) => db.run(sql, params, function (err) { err ? reject(err) : resolve(this); }));
const get = (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const all = (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));

async function main() {
  const columns = await all('PRAGMA table_info(users)');
  if (!columns.length) throw new Error('No existe la tabla users. Iniciá Calistium una vez con npm start y volvé a ejecutar el comando.');
  if (!columns.some(column => column.name === 'role')) {
    await run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'");
  }

  let user = await get('SELECT * FROM users WHERE lower(email) = ?', [email]);
  let gameData = {};
  if (user) {
    try { gameData = JSON.parse(user.gameData || '{}'); } catch (_) { gameData = {}; }
  } else {
    const randomPasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10);
    gameData = {};
    await run('INSERT INTO users (name, email, password, role, gameData) VALUES (?, ?, ?, ?, ?)', [nameFromEnv, email, randomPasswordHash, 'admin', JSON.stringify({})]);
    user = await get('SELECT * FROM users WHERE lower(email) = ?', [email]);
  }

  // Estado de demostración: exactamente 2 de los 4 logros base desbloqueados.
  // Se conservan las rutinas, foto de perfil, nivel, XP, estadísticas y lecciones; únicamente
  // se preparan estos campos de demostración para que los otros dos logros sigan bloqueados.
  gameData = {
    level: 1, xp: 0, maxXP: 100, strength: 1, endurance: 1, agility: 1, mentality: 1,
    completedExercises: [], equipment: [], currentLessonIndex: 0, totalWorkouts: 7,
    achievementsUnlocked: ['first_workout', 'week_warrior'], completedLessons: [], courseCompleted: false,
    routineDraft: [], savedRoutines: [], workoutHistory: [],
    ...gameData,
    totalWorkouts: 7,
    completedExercises: [],
    equipment: [],
    achievementsUnlocked: ['first_workout', 'week_warrior']
  };
  await run('UPDATE users SET role = ?, gameData = ? WHERE id = ?', ['admin', JSON.stringify(gameData), user.id]);
  console.log('Cuenta de demostración ExpoTec preparada.');
  console.log(`Email configurado: ${email}`);
  console.log('Rol: admin · Logros desbloqueados: 2 de 4.');
  console.log('Iniciá sesión con ese email desde Google Login. No hay una contraseña de demostración que compartir.');
  console.log('Aviso: para ajustar la demo se reinician los hitos completedExercises/equipment y totalWorkouts; se conservan rutinas, foto, nivel, XP, estadísticas y lecciones.');
}

main().catch(error => {
  console.error('No se pudo preparar la cuenta ExpoTec:', error.message);
  process.exitCode = 1;
}).finally(() => db.close());
