const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const { OAuth2Client } = require('google-auth-library');
const { getWgerCatalog } = require('./services/wger-catalog');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const app = express();

// Middleware: el frontend se sirve desde el mismo servidor; CORS solo permite orígenes locales
// por defecto. Se pueden sumar orígenes de despliegue mediante CORS_ORIGIN.
const allowedOrigins = String(process.env.CORS_ORIGIN || 'http://localhost:3000,http://127.0.0.1:3000')
    .split(',').map(origin => origin.trim()).filter(Boolean);
app.use(cors({ origin: (origin, callback) => {
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(null, false);
} }));
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// En desarrollo se genera una clave temporal si falta JWT_SECRET. Para publicar
// la aplicación, configurá siempre una clave estable en el archivo .env.
const configuredSecret = String(process.env.JWT_SECRET || '').trim();
const hasUsableSecret = configuredSecret.length >= 32 && !/REEMPLAZAR|CHANGE_ME|CAMBIAR|PLACEHOLDER/i.test(configuredSecret);
if (process.env.NODE_ENV === 'production' && !hasUsableSecret) {
    console.error('❌ En producción es obligatorio configurar JWT_SECRET con una clave aleatoria de al menos 32 caracteres.');
    process.exit(1);
}
const JWT_SECRET = hasUsableSecret ? configuredSecret : crypto.randomBytes(48).toString('hex');
if (!hasUsableSecret) {
    console.warn('⚠️ JWT_SECRET no está configurado con una clave real. Se usará una clave temporal: las sesiones se cerrarán al reiniciar el servidor.');
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'evoself.db');
const normalizeEmail = (value) => String(value || '').trim().toLowerCase();
const defaultGameData = () => ({
    level: 1, xp: 0, maxXP: 100, strength: 1, endurance: 1, agility: 1, mentality: 1,
    completedExercises: [], equipment: [], currentLessonIndex: 0, totalWorkouts: 0,
    achievementsUnlocked: [], completedLessons: [], courseCompleted: false,
    routineDraft: [], savedRoutines: [], workoutHistory: []
});

// Configuración de la base de datos SQLite. DB_PATH permite usar una copia de prueba.
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('❌ Error al conectar con la base de datos:', err.message);
    } else {
        console.log('✅ Conectado a la base de datos SQLite');
    }
});

// Crear tabla de usuarios si no existe
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        googleId TEXT,
        profilePhoto TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        gameData TEXT DEFAULT '{}',
        registrationDate DATETIME DEFAULT CURRENT_TIMESTAMP,
        lastLogin DATETIME DEFAULT CURRENT_TIMESTAMP
    )`, (err) => {
        if (err) {
            console.error('Error creando tabla users:', err.message);
        } else {
            console.log('✅ Tabla de usuarios lista');
            db.all('PRAGMA table_info(users)', (columnErr, columns) => {
                if (columnErr) return console.error('No se pudo verificar el esquema de usuarios:', columnErr.message);
                if (!columns.some(column => column.name === 'googleId')) {
                    db.run('ALTER TABLE users ADD COLUMN googleId TEXT', (alterErr) => {
                        if (alterErr) console.error('No se pudo agregar googleId:', alterErr.message);
                        else console.log('✅ Migración de Google Login aplicada');
                    });
                }
                if (!columns.some(column => column.name === 'profilePhoto')) {
                    db.run('ALTER TABLE users ADD COLUMN profilePhoto TEXT', (photoErr) => {
                        if (photoErr) console.error('No se pudo agregar profilePhoto:', photoErr.message);
                        else console.log('✅ Campo de foto de perfil preparado');
                    });
                }
                if (!columns.some(column => column.name === 'role')) {
                    db.run("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'user'", (roleErr) => {
                        if (roleErr) console.error('No se pudo agregar el rol del usuario:', roleErr.message);
                        else console.log('✅ Campo de rol preparado');
                    });
                }
                db.run('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users(googleId) WHERE googleId IS NOT NULL', (indexErr) => {
                    if (indexErr) console.error('No se pudo crear el índice de Google:', indexErr.message);
                });
            });
        }
    });
});

// Middleware de autenticación
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) {
        return res.status(401).json({ error: 'Token no proporcionado' });
    }

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ error: 'Token inválido' });
        }
        req.userId = user.id;
        req.authProvider = user.authProvider || 'password';
        next();
    });
};

// RUTAS DE AUTENTICACIÓN

// Registro
app.post('/api/register', async (req, res) => {
    try {
        const { name, password } = req.body;
        const email = normalizeEmail(req.body.email);
        const suppliedGameData = req.body.gameData;

        // Validaciones
        if (!name || name.length < 2) {
            return res.status(400).json({ error: 'El nombre debe tener al menos 2 caracteres' });
        }

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            return res.status(400).json({ error: 'Email inválido' });
        }

        if (!password || password.length < 6) {
            return res.status(400).json({ error: 'La contraseña debe tener al menos 6 caracteres' });
        }

        if (suppliedGameData !== undefined && (!suppliedGameData || typeof suppliedGameData !== 'object' || Array.isArray(suppliedGameData) || JSON.stringify(suppliedGameData).length > 100000)) {
            return res.status(400).json({ error: 'Los datos de progreso no son válidos.' });
        }

        // Verificar si el usuario ya existe
        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, existingUser) => {
            if (err) {
                return res.status(500).json({ error: 'Error al verificar usuario' });
            }

            if (existingUser) {
                return res.status(400).json({ error: 'El email ya está registrado' });
            }

            // Hash de la contraseña
            const hashedPassword = await bcrypt.hash(password, 10);

            // Usa progreso inicial para cuentas nuevas o conserva el progreso entregado
            // durante la migración de una cuenta local ya existente.
            const initialGameData = JSON.stringify({
                ...defaultGameData(),
                ...(suppliedGameData || {})
            });

            // Crear nuevo usuario
            db.run('INSERT INTO users (name, email, password, gameData) VALUES (?, ?, ?, ?)',
                [name, email, hashedPassword, initialGameData],
                function(err) {
                    if (err) {
                        return res.status(500).json({ error: 'Error al crear usuario' });
                    }

                    // Generar token
                    const token = jwt.sign(
                        { id: this.lastID },
                        JWT_SECRET,
                        { expiresIn: '7d' }
                    );

                    res.status(201).json({
                        message: 'Usuario registrado exitosamente',
                        token,
                        user: {
                            id: this.lastID,
                            name: name,
                            email: email,
                            profilePhoto: '',
                            role: 'user',
                            gameData: JSON.parse(initialGameData)
                        }
                    });
                }
            );
        });
    } catch (error) {
        console.error('Error en registro:', error);
        res.status(500).json({ error: 'Error al registrar usuario' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    try {
        const email = normalizeEmail(req.body.email);
        const { password } = req.body;
        if (!email || !password) return res.status(400).json({ error: 'Completá el email y la contraseña.' });

        // Buscar usuario
        db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
            if (err) {
                return res.status(500).json({ error: 'Error al buscar usuario' });
            }

            if (!user) {
                return res.status(400).json({ error: 'Credenciales incorrectas' });
            }

            // Verificar contraseña
            const isValidPassword = await bcrypt.compare(password, user.password);
            if (!isValidPassword) {
                return res.status(400).json({ error: 'Credenciales incorrectas' });
            }

            // Actualizar último login
            db.run('UPDATE users SET lastLogin = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);

            // Generar token
            const token = jwt.sign(
                { id: user.id },
                JWT_SECRET,
                { expiresIn: '7d' }
            );

            res.json({
                message: 'Login exitoso',
                token,
                user: {
                    id: user.id,
                    name: user.name,
                    email: user.email,
                    profilePhoto: user.profilePhoto || '',
                    role: user.role || 'user',
                    gameData: JSON.parse(user.gameData)
                }
            });
        });
    } catch (error) {
        console.error('Error en login:', error);
        res.status(500).json({ error: 'Error al iniciar sesión' });
    }
});

// Configuración pública mínima: el Client ID no es secreto; nunca se expone la clave privada del proveedor de imágenes.
app.get('/api/config', (_req, res) => {
    res.json({ googleClientId: process.env.GOOGLE_CLIENT_ID || '' });
});

// Google Identity Services entrega un ID token que se verifica en el servidor.
app.post('/api/auth/google', async (req, res) => {
    const idToken = String(req.body && req.body.credential || '');
    const clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) return res.status(503).json({ error: 'Google Login todavía no está configurado. Falta GOOGLE_CLIENT_ID en .env.' });
    if (!idToken || idToken.length > 20000) return res.status(400).json({ error: 'La credencial de Google no es válida.' });

    try {
        const client = new OAuth2Client(clientId);
        const ticket = await client.verifyIdToken({ idToken, audience: clientId });
        const payload = ticket.getPayload();
        if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
            return res.status(401).json({ error: 'Google no confirmó una dirección de email verificada.' });
        }
        const email = normalizeEmail(payload.email);
        const googleId = String(payload.sub);

        db.get('SELECT * FROM users WHERE googleId = ?', [googleId], (lookupErr, googleUser) => {
            if (lookupErr) return res.status(500).json({ error: 'No se pudo consultar la cuenta de Google.' });
            const finishLogin = (user, statusCode = 200) => {
                db.run('UPDATE users SET lastLogin = CURRENT_TIMESTAMP WHERE id = ?', [user.id]);
                const token = jwt.sign({ id: user.id, authProvider: 'google' }, JWT_SECRET, { expiresIn: '7d' });
                let savedGameData = {};
                try { savedGameData = JSON.parse(user.gameData || '{}'); } catch (_) { savedGameData = {}; }
                return res.status(statusCode).json({
                    message: 'Inicio de sesión con Google exitoso', token,
                    user: { id: user.id, name: user.name, email: user.email, profilePhoto: user.profilePhoto || '', role: user.role || 'user', authProvider: 'google', gameData: { ...defaultGameData(), ...savedGameData } }
                });
            };
            if (googleUser) return finishLogin(googleUser);

            // Si el email verificado ya existe en Calistium, se vincula a esa cuenta.
            // El índice único evita que un mismo Google ID se vincule a dos usuarios.
            db.get('SELECT * FROM users WHERE lower(email) = ?', [email], async (emailErr, existingUser) => {
                if (emailErr) return res.status(500).json({ error: 'No se pudo consultar la cuenta existente.' });
                if (existingUser) {
                    if (existingUser.googleId && existingUser.googleId !== googleId) {
                        return res.status(409).json({ error: 'Esta cuenta ya está vinculada a otra identidad de Google.' });
                    }
                    return db.run('UPDATE users SET googleId = ? WHERE id = ?', [googleId, existingUser.id], function (updateErr) {
                        if (updateErr) return res.status(500).json({ error: 'No se pudo vincular la cuenta de Google.' });
                        existingUser.googleId = googleId;
                        return finishLogin(existingUser);
                    });
                }

                try {
                    const unusablePasswordHash = await bcrypt.hash(crypto.randomBytes(48).toString('hex'), 10);
                    const gameData = JSON.stringify(defaultGameData());
                    const name = String(payload.name || email.split('@')[0]).slice(0, 100);
                    db.run('INSERT INTO users (name, email, password, googleId, gameData) VALUES (?, ?, ?, ?, ?)',
                        [name, email, unusablePasswordHash, googleId, gameData], function (insertErr) {
                            if (insertErr) return res.status(500).json({ error: 'No se pudo crear la cuenta de Calistium.' });
                            return finishLogin({ id: this.lastID, name, email, profilePhoto: '', role: 'user', gameData }, 201);
                        });
                } catch (_) {
                    return res.status(500).json({ error: 'No se pudo crear la cuenta.' });
                }
            });
        });
    } catch (error) {
        console.warn('Verificación de Google fallida:', error.message);
        return res.status(401).json({ error: 'No se pudo verificar la sesión de Google. Intentá nuevamente.' });
    }
});

// Obtener datos del usuario
app.get('/api/user', authenticateToken, (req, res) => {
    db.get('SELECT id, name, email, googleId, profilePhoto, role, gameData FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Error al obtener usuario' });
        }

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        res.json({
            id: user.id,
            _id: user.id,
            name: user.name,
            email: user.email,
            profilePhoto: user.profilePhoto || '',
            role: user.role || 'user',
            gameData: JSON.parse(user.gameData),
            authProvider: req.authProvider || 'password'
        });
    });
});

// Guardar progreso del juego
app.post('/api/save-game', authenticateToken, (req, res) => {
    const { gameData } = req.body;
    if (!gameData || typeof gameData !== 'object' || Array.isArray(gameData) || JSON.stringify(gameData).length > 100000) {
        return res.status(400).json({ error: 'Los datos de progreso no son válidos.' });
    }

    const allowedGameKeys = new Set([...Object.keys(defaultGameData()), 'lastSaved']);
    const safeGameData = Object.fromEntries(Object.entries(gameData).filter(([key]) => allowedGameKeys.has(key)));

    db.get('SELECT gameData FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Error al obtener usuario' });
        }

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        let previousGameData = {};
        try { previousGameData = JSON.parse(user.gameData || '{}'); } catch (_) { previousGameData = {}; }
        const updatedGameData = JSON.stringify({ ...defaultGameData(), ...previousGameData, ...safeGameData });

        db.run('UPDATE users SET gameData = ? WHERE id = ?', [updatedGameData, req.userId], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Error al guardar progreso' });
            }

            res.json({
                message: 'Progreso guardado exitosamente',
                gameData: JSON.parse(updatedGameData)
            });
        });
    });
});

// Generación opcional mediante Stability AI Inpaint. El usuario pinta una máscara de las
// zonas del cuerpo que quiere modificar; los píxeles negros de la máscara se conservan.
// La fotografía solo se envía al proveedor después del consentimiento y no se persiste.
const aiUsageByUser = new Map();
app.post('/api/ai/physique', authenticateToken, async (req, res) => {
    if (!process.env.STABILITY_API_KEY) {
        return res.status(503).json({ error: 'La función de imágenes todavía no está configurada. Falta STABILITY_API_KEY en el archivo .env.' });
    }
    if (!req.body || req.body.consent !== true) {
        return res.status(400).json({ error: 'Tenés que aceptar el procesamiento externo de la fotografía.' });
    }

    const imageData = String(req.body.imageData || '');
    const imageMatch = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!imageMatch) return res.status(400).json({ error: 'Subí una imagen JPG, PNG o WebP válida.' });
    const mimeType = imageMatch[1];
    const imageBuffer = Buffer.from(imageMatch[2], 'base64');
    if (!imageBuffer.length || imageBuffer.length > 5 * 1024 * 1024) {
        return res.status(413).json({ error: 'La fotografía preparada debe pesar 5 MB o menos.' });
    }
    const isJpeg = mimeType === 'image/jpeg' && imageBuffer.length >= 3 && imageBuffer[0] === 0xff && imageBuffer[1] === 0xd8 && imageBuffer[2] === 0xff;
    const isPng = mimeType === 'image/png' && imageBuffer.length >= 8 && imageBuffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const isWebp = mimeType === 'image/webp' && imageBuffer.length >= 12 && imageBuffer.toString('ascii', 0, 4) === 'RIFF' && imageBuffer.toString('ascii', 8, 12) === 'WEBP';
    if (!(isJpeg || isPng || isWebp)) return res.status(400).json({ error: 'El archivo no parece ser una imagen válida del tipo declarado.' });

    const maskData = String(req.body.maskData || '');
    const maskMatch = maskData.match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
    if (!maskMatch) return res.status(400).json({ error: 'Falta la máscara de edición. Marcá en rojo las zonas musculares que querés modificar.' });
    const maskBuffer = Buffer.from(maskMatch[1], 'base64');
    const pngSignature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
    if (!maskBuffer.length || maskBuffer.length > 3 * 1024 * 1024 || maskBuffer.length < 24 || !maskBuffer.subarray(0, 8).equals(pngSignature)) {
        return res.status(400).json({ error: 'La máscara de edición no es un PNG válido o es demasiado grande. Volvé a marcar la zona del cuerpo.' });
    }

    const now = Date.now();
    const prior = aiUsageByUser.get(req.userId) || [];
    const recent = prior.filter(timestamp => now - timestamp < 60 * 60 * 1000);
    if (recent.length >= 3) return res.status(429).json({ error: 'Alcanzaste el límite de 3 visualizaciones por hora. Probá más tarde.' });
    // Reservar un intento antes de llamar al proveedor para evitar solicitudes paralelas repetidas.
    recent.push(now);
    aiUsageByUser.set(req.userId, recent);

    const prompt = 'Photorealistic, natural enhancement of the existing adult person in the MASKED BODY AREAS ONLY. Add a modest and believable amount of muscular development to the painted shoulders, arms, chest and abdominal area, as a hypothetical future physique after consistent training. Match the exact original skin tone, lighting direction, shadows, camera perspective, anatomy and body proportions. Continue seamlessly from the unmasked pixels. Keep the original photograph; do not create a new scene.';
    const negativePrompt = 'face, head, hair, background, room, shelf, books, extra people, collage, contact sheet, text, labels, watermark, changed identity, changed facial features, altered hairstyle, different pose, different camera angle, distorted anatomy, extra limbs, exaggerated bodybuilding muscles, plastic skin, unrealistic abs';
    const extension = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
    const configuredGrowMask = Number.parseInt(process.env.STABILITY_GROW_MASK || '2', 10);
    const growMask = Number.isFinite(configuredGrowMask) ? Math.max(0, Math.min(10, configuredGrowMask)) : 2;

    try {
        const form = new FormData();
        form.append('image', new Blob([imageBuffer], { type: mimeType }), `foto-inicial.${extension}`);
        form.append('mask', new Blob([maskBuffer], { type: 'image/png' }), 'mascara-cuerpo.png');
        form.append('prompt', prompt);
        form.append('negative_prompt', negativePrompt);
        form.append('grow_mask', String(growMask));
        form.append('output_format', 'png');

        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 120000);
        let response;
        try {
            response = await fetch('https://api.stability.ai/v2beta/stable-image/edit/inpaint', {
                method: 'POST',
                headers: {
                    Authorization: `Bearer ${process.env.STABILITY_API_KEY}`,
                    Accept: 'image/*'
                },
                body: form,
                signal: controller.signal
            });
        } finally {
            clearTimeout(timeout);
        }

        if (!response.ok) {
            const bodyText = await response.text().catch(() => '');
            let detail = '';
            try {
                const bodyJson = JSON.parse(bodyText);
                detail = String(bodyJson.message || bodyJson.error || (Array.isArray(bodyJson.errors) ? bodyJson.errors.join('; ') : '') || '').slice(0, 400);
            } catch (_) {
                detail = bodyText.slice(0, 300);
            }
            // Dejar el detalle disponible en la terminal del servidor, nunca la clave.
            console.warn('Stability AI Inpaint respondió con error:', response.status, detail);
            if (response.status === 401) {
                return res.status(502).json({ error: 'Stability AI rechazó la clave. Revisá STABILITY_API_KEY en .env y copiá la clave completa.' });
            }
            if (response.status === 402) {
                return res.status(502).json({ error: 'Tu cuenta de Stability AI no tiene créditos disponibles para esta edición. Revisá el saldo de tu cuenta.' });
            }
            if (response.status === 403) {
                return res.status(502).json({ error: 'Stability AI rechazó esta solicitud por permisos o filtros de seguridad. Probá con otra fotografía y una máscara limitada a las zonas musculares.' });
            }
            if (response.status === 413) {
                return res.status(413).json({ error: 'La fotografía o la máscara supera el tamaño admitido por Stability AI. Elegí una foto más liviana.' });
            }
            if (response.status === 422 || response.status === 400) {
                return res.status(502).json({ error: 'Stability AI no pudo procesar la fotografía o la máscara. Comprobá que hayas pintado una zona del cuerpo y volvé a intentar.' });
            }
            if (response.status === 429) {
                return res.status(429).json({ error: 'Stability AI aplicó un límite temporal de solicitudes. Esperá un minuto antes de volver a intentarlo.' });
            }
            return res.status(502).json({ error: 'Stability AI no pudo editar la imagen. Revisá la terminal del servidor para ver el código y el detalle del proveedor.' });
        }

        const resultBuffer = Buffer.from(await response.arrayBuffer());
        if (!resultBuffer.length) return res.status(502).json({ error: 'Stability AI no devolvió una imagen utilizable.' });
        return res.json({
            imageData: `data:image/png;base64,${resultBuffer.toString('base64')}`,
            disclaimer: 'Visualización generada por IA; las zonas no marcadas se intentan conservar, pero el resultado sigue siendo ilustrativo y no predice resultados físicos.'
        });
    } catch (error) {
        console.warn('Error al editar imagen con Stability AI:', error.name === 'AbortError' ? 'timeout' : error.message);
        return res.status(502).json({ error: error.name === 'AbortError' ? 'La generación demoró demasiado. Intentá nuevamente.' : 'No se pudo conectar con Stability AI. Revisá la conexión a Internet.' });
    }
});

// Catálogo de ejercicios: nombres, instrucciones, imágenes y datos proceden de wger.
// Se usa caché local de 24 horas; si wger falla, se conserva el último catálogo descargado.
app.get('/api/exercises', async (req, res) => {
    try {
        const catalog = await getWgerCatalog({ forceRefresh: String(req.query.refresh || '') === '1' });
        res.set('Cache-Control', 'no-store');
        return res.json({
            source: catalog.source,
            generatedAt: catalog.generatedAt,
            count: catalog.exercises.length,
            staleCache: Boolean(catalog.staleCache),
            warning: catalog.warning || '',
            exercises: catalog.exercises
        });
    } catch (error) {
        console.warn('No se pudo cargar el catálogo de wger:', error.message);
        return res.status(503).json({ error: 'No se pudo cargar el catálogo de ejercicios de wger. Comprobá la conexión a internet y volvé a intentar.' });
    }
});

// Foto de perfil, guardada en la propia cuenta de Calistium. No se envía a un proveedor de IA.
app.put('/api/profile/photo', authenticateToken, (req, res) => {
    const imageData = String(req.body && req.body.imageData || '');
    const match = imageData.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!match) return res.status(400).json({ error: 'Elegí una foto JPG, PNG o WebP válida.' });
    const mimeType = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    if (!buffer.length || buffer.length > 2 * 1024 * 1024) {
        return res.status(413).json({ error: 'La foto de perfil debe pesar 2 MB o menos.' });
    }
    const validJpeg = mimeType === 'image/jpeg' && buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
    const validPng = mimeType === 'image/png' && buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const validWebp = mimeType === 'image/webp' && buffer.length >= 12 && buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
    if (!(validJpeg || validPng || validWebp)) return res.status(400).json({ error: 'El archivo no parece ser una imagen válida.' });

    db.run('UPDATE users SET profilePhoto = ? WHERE id = ?', [imageData, req.userId], function (err) {
        if (err) return res.status(500).json({ error: 'No se pudo guardar la foto de perfil.' });
        if (!this.changes) return res.status(404).json({ error: 'No se encontró tu cuenta.' });
        return res.json({ ok: true, profilePhoto: imageData });
    });
});

app.delete('/api/profile/photo', authenticateToken, (req, res) => {
    db.run('UPDATE users SET profilePhoto = NULL WHERE id = ?', [req.userId], function (err) {
        if (err) return res.status(500).json({ error: 'No se pudo eliminar la foto de perfil.' });
        if (!this.changes) return res.status(404).json({ error: 'No se encontró tu cuenta.' });
        return res.json({ ok: true });
    });
});

// Estado básico para comprobar que el servidor y la API responden.
app.get('/api/health', (_req, res) => {
    res.json({ ok: true, servicio: 'Calistium API' });
});

// Eliminar cuenta en el servidor. Requiere contraseña para confirmar la acción.
app.delete('/api/account', authenticateToken, (req, res) => {
    const password = String((req.body && req.body.password) || '');
    db.get('SELECT id, password, googleId FROM users WHERE id = ?', [req.userId], async (err, user) => {
        if (err) return res.status(500).json({ error: 'No se pudo verificar la cuenta.' });
        if (!user) return res.status(404).json({ error: 'La cuenta ya no existe.' });
        try {
            // Las cuentas que acaban de autenticarse con Google pueden confirmar la baja
            // mediante el token firmado del flujo Google; las demás requieren contraseña.
            const googleSession = Boolean(user.googleId && req.authProvider === 'google');
            if (!googleSession) {
                if (!password) return res.status(400).json({ error: 'Ingresá tu contraseña para confirmar.' });
                const valid = await bcrypt.compare(password, user.password);
                if (!valid) return res.status(401).json({ error: 'La contraseña no es correcta.' });
            }
            db.run('DELETE FROM users WHERE id = ?', [req.userId], function (deleteErr) {
                if (deleteErr) return res.status(500).json({ error: 'No se pudo eliminar la cuenta.' });
                return res.json({ ok: true, message: 'Cuenta eliminada.' });
            });
        } catch (verifyErr) {
            return res.status(500).json({ error: 'No se pudo verificar la contraseña.' });
        }
    });
});

// Completar ejercicio
app.post('/api/complete-exercise', authenticateToken, (req, res) => {
    const { exerciseId, xpReward, statBoost, currentLevel } = req.body;

    db.get('SELECT gameData FROM users WHERE id = ?', [req.userId], (err, user) => {
        if (err) {
            return res.status(500).json({ error: 'Error al obtener usuario' });
        }

        if (!user) {
            return res.status(404).json({ error: 'Usuario no encontrado' });
        }

        const gameData = JSON.parse(user.gameData);

        // Verificar si ya completó el ejercicio
        if (gameData.completedExercises.includes(exerciseId)) {
            return res.status(400).json({ error: 'Ya completaste este ejercicio' });
        }

        // Actualizar progreso
        gameData.completedExercises.push(exerciseId);
        gameData.xp += xpReward;
        gameData.totalWorkouts += 1;
        gameData[statBoost] += 1;

        let leveledUp = false;

        // Verificar level up
        while (gameData.xp >= gameData.maxXP) {
            gameData.level += 1;
            gameData.xp -= gameData.maxXP;
            gameData.maxXP = Math.floor(gameData.maxXP * 1.2);
            gameData.strength += 1;
            gameData.endurance += 1;
            leveledUp = true;
        }

        db.run('UPDATE users SET gameData = ? WHERE id = ?', [JSON.stringify(gameData), req.userId], function(err) {
            if (err) {
                return res.status(500).json({ error: 'Error al completar ejercicio' });
            }

            res.json({
                message: 'Ejercicio completado',
                gameData: gameData,
                leveledUp: leveledUp
            });
        });
    });
});

// Puerto del servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor corriendo en http://localhost:${PORT}`);
    console.log(`📁 Base de datos: ${DB_PATH} (SQLite)`);
    console.log('✅ Servidor listo para recibir peticiones');
});

// Cerrar la base de datos al terminar
process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('🔌 Conexión a la base de datos cerrada');
        process.exit(0);
    });
});