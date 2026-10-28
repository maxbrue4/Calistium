// ==================== VARIABLES GLOBALES ====================
let currentUser = null;
let authToken = localStorage.getItem('calistium_token') || '';
let saveRequestInProgress = null;
let exercises = []; // Catálogo importado desde la API pública de wger; no hay lista manual embebida.
let exercisesLoaded = false;
let exercisesLoadingPromise = null;
let googleButtonsRendered = false;
let gameData = defaultGameData();

function defaultGameData() {
    return {
        level: 1, xp: 0, maxXP: 100, strength: 1, endurance: 1, agility: 1, mentality: 1,
        completedExercises: [], equipment: [], currentLessonIndex: 0, totalWorkouts: 0,
        achievementsUnlocked: [], completedLessons: [], courseCompleted: false,
        routineDraft: [], savedRoutines: [], workoutHistory: []
    };
}

function normalizeGameData(saved) {
    const base = defaultGameData();
    const result = { ...base, ...(saved && typeof saved === 'object' ? saved : {}) };
    for (const key of ['completedExercises', 'equipment', 'achievementsUnlocked', 'completedLessons', 'routineDraft', 'savedRoutines', 'workoutHistory']) {
        if (!Array.isArray(result[key])) result[key] = [];
    }
    if (!Number.isFinite(Number(result.level)) || Number(result.level) < 1) result.level = 1;
    if (!Number.isFinite(Number(result.xp)) || Number(result.xp) < 0) result.xp = 0;
    if (!Number.isFinite(Number(result.maxXP)) || Number(result.maxXP) < 1) result.maxXP = 100;
    return result;
}

async function apiRequest(endpoint, options = {}) {
    const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
    const token = options.tokenOverride !== undefined ? options.tokenOverride : authToken;
    delete options.tokenOverride;
    if (token) headers.Authorization = `Bearer ${token}`;
    let response;
    try {
        response = await fetch(endpoint, { ...options, headers });
    } catch (error) {
        const networkError = new Error('No pude conectarme con el servidor de Calistium.');
        networkError.isNetworkError = true;
        throw networkError;
    }
    let payload = {};
    try { payload = await response.json(); }
    catch (_) {
        const parseError = new Error('El servidor respondió con un formato inesperado. Ejecutá Calistium con npm start.');
        parseError.status = response.status;
        parseError.isNetworkError = !response.headers.get('content-type')?.includes('application/json');
        throw parseError;
    }
    if (!response.ok) {
        const error = new Error(payload.error || 'No se pudo completar la operación.');
        error.status = response.status;
        throw error;
    }
    return payload;
}

// Las cuentas de prueba del año pasado vivían en localStorage y no eran cuentas reales.
// Por decisión del propietario se eliminan sus claves heredadas; el login actual usa el servidor.
function clearLegacyTestAccounts() {
    try {
        const legacyKeys = Object.keys(localStorage).filter(key =>
            key === 'fitpixel_users' ||
            key === 'fitpixel_current_session' ||
            key.startsWith('fitpixel_backup_') ||
            key === 'calistium_last_email'
        );
        legacyKeys.forEach(key => localStorage.removeItem(key));

        // También descartar una sesión de servidor heredada una sola vez, porque el propietario
        // confirmó que todas las cuentas existentes eran pruebas. A partir de ahora, los tokens
        // de las nuevas cuentas reales (incluida Google) se conservan entre recargas.
        const cleanupMarker = 'calistium_cuentas_de_prueba_limpiadas_v1';
        if (localStorage.getItem(cleanupMarker) !== '1') {
            localStorage.removeItem('calistium_token');
            localStorage.removeItem('calistium_last_email');
            localStorage.setItem(cleanupMarker, '1');
        }
    } catch (error) {
        console.warn('No se pudieron limpiar las cuentas locales de prueba:', error.message);
    }
}
clearLegacyTestAccounts();

function applyUserSession(user, token = '') {
    currentUser = { ...user, email: String(user.email || '').trim().toLowerCase() };
    gameData = normalizeGameData(user.gameData);
    authToken = token || '';
    if (authToken) localStorage.setItem('calistium_token', authToken);
    else localStorage.removeItem('calistium_token');
    const stableUserId = currentUser.id ?? currentUser._id ?? currentUser.email;
    if (stableUserId) localStorage.setItem('calistium_user_id', String(stableUserId));
    else localStorage.removeItem('calistium_user_id');
}

// Toggle del menú de cuenta
function toggleAccountMenu() {
    const menu = document.getElementById('accountMenu');
    if (!menu) return;
    const isVisible = menu.style.display === 'block';
    menu.style.display = isVisible ? 'none' : 'block';
    if (!isVisible && currentUser) {
        const accountEmail = document.getElementById('accountEmail');
        if (accountEmail) accountEmail.textContent = currentUser.email;
    }
}

document.addEventListener('click', function(event) {
    const menu = document.getElementById('accountMenu');
    const btn = document.getElementById('accountBtn');
    if (menu && btn && !menu.contains(event.target) && !btn.contains(event.target)) menu.style.display = 'none';
});

// El inicio de sesión usa exclusivamente las cuentas del servidor.
// Las cuentas de prueba antiguas se limpian; no se migran ni se restauran.
async function login(email, password) {
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const response = await apiRequest('/api/login', {
        method: 'POST', tokenOverride: '',
        body: JSON.stringify({ email: normalizedEmail, password })
    });
    applyUserSession(response.user, response.token);
    return true;
}

// El registro nuevo siempre usa el backend; nunca almacena contraseñas en texto plano.
async function register(name, email, password) {
    const response = await apiRequest('/api/register', {
        method: 'POST', tokenOverride: '',
        body: JSON.stringify({ name: String(name || '').trim(), email: String(email || '').trim().toLowerCase(), password })
    });
    applyUserSession(response.user, response.token);
    return true;
}

function saveGameData() {
    if (!currentUser) return;
    gameData = normalizeGameData(gameData);
    const snapshot = { ...gameData, lastSaved: new Date().toISOString() };

    // El progreso sincronizado se guarda en SQLite mediante la API autenticada.
    if (authToken) {
        const body = JSON.stringify({ gameData: snapshot });
        // No se esperan respuestas dentro de beforeunload; keepalive permite terminar el envío.
        try {
            const request = fetch('/api/save-game', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
                body,
                keepalive: true
            }).catch(error => console.warn('No se pudo guardar el progreso en el servidor:', error));
            saveRequestInProgress = request;
        } catch (error) {
            console.warn('No se pudo iniciar el guardado del progreso:', error);
        }
    }
}

async function logout() {
    // Intentá terminar el guardado en curso antes de cerrar la sesión.
    try {
        saveGameData();
        if (saveRequestInProgress) await saveRequestInProgress;
    } catch (error) {
        console.warn('No se pudo confirmar el último guardado antes de cerrar sesión:', error.message);
    }
    currentUser = null;
    authToken = '';
    localStorage.removeItem('calistium_token');
    localStorage.removeItem('calistium_user_id');
    gameData = defaultGameData();
    const appScreen = document.getElementById('appScreen');
    const loginScreen = document.getElementById('loginScreen');
    if (appScreen) appScreen.style.display = 'none';
    if (loginScreen) loginScreen.style.display = 'flex';
}

async function deleteAccount() {
    if (!currentUser) return;
    const confirmDelete = confirm('¿Estás seguro de que querés eliminar tu cuenta y todo tu progreso? Esta acción no se puede deshacer.');
    if (!confirmDelete) return;
    const doubleConfirm = confirm('Última confirmación: ¿querés eliminar definitivamente la cuenta?');
    if (!doubleConfirm) return;

    if (authToken) {
        let password = '';
        if (currentUser.authProvider !== 'google') {
            password = prompt('Por seguridad, ingresá tu contraseña actual para eliminar la cuenta:');
            if (!password) return;
        }
        try {
            await apiRequest('/api/account', { method: 'DELETE', body: JSON.stringify({ password }) });
        } catch (error) {
            alert(error.message || 'No se pudo eliminar la cuenta.');
            return;
        }
    }

    localStorage.removeItem('calistium_token');
    localStorage.removeItem('calistium_user_id');
    authToken = '';
    currentUser = null;
    gameData = defaultGameData();
    alert('La cuenta se eliminó correctamente.');
    const appScreen = document.getElementById('appScreen');
    const loginScreen = document.getElementById('loginScreen');
    if (appScreen) appScreen.style.display = 'none';
    if (loginScreen) loginScreen.style.display = 'flex';
}

function togglePasswordVisibility(inputId) {
    const input = document.getElementById(inputId);
    if (!input) return;
    const button = input.nextElementSibling;
    if (input.type === 'password') {
        input.type = 'text';
        if (button) button.textContent = '🙈';
    } else {
        input.type = 'password';
        if (button) button.textContent = '👁️';
    }
}

// ==================== GOOGLE LOGIN ====================
window.initializeGoogleSignIn = async function initializeGoogleSignIn() {
    if (googleButtonsRendered) return;
    try {
        const configResponse = await fetch('/api/config');
        const config = await configResponse.json();
        const sections = [document.getElementById('googleLoginSection'), document.getElementById('googleRegisterSection')].filter(Boolean);
        const help = document.querySelectorAll('.google-config-help');
        if (!configResponse.ok || !config.googleClientId) {
            sections.forEach(section => { section.style.display = 'block'; });
            help.forEach(item => { item.textContent = 'Para activar el acceso con Google, configurá GOOGLE_CLIENT_ID en el archivo .env y reiniciá el servidor.'; item.style.display = 'block'; });
            return;
        }
        if (!window.google || !google.accounts || !google.accounts.id) {
            help.forEach(item => { item.textContent = 'No se pudo cargar el servicio de Google. Comprobá tu conexión a internet y recargá la página.'; item.style.display = 'block'; });
            return;
        }

        google.accounts.id.initialize({
            client_id: config.googleClientId,
            callback: window.handleGoogleCredential,
            auto_select: false,
            cancel_on_tap_outside: true
        });
        const options = { type: 'standard', theme: 'outline', size: 'large', text: 'continue_with', shape: 'rectangular', logo_alignment: 'left', locale: 'es', width: 300 };
        const loginHost = document.getElementById('googleLoginButton');
        const registerHost = document.getElementById('googleRegisterButton');
        if (loginHost) google.accounts.id.renderButton(loginHost, options);
        if (registerHost) google.accounts.id.renderButton(registerHost, options);
        const loginSection = document.getElementById('googleLoginSection');
        const registerSection = document.getElementById('googleRegisterSection');
        if (loginSection) loginSection.style.display = 'block';
        if (registerSection) registerSection.style.display = 'block';
        help.forEach(item => { item.style.display = 'none'; });
        googleButtonsRendered = true;
    } catch (error) {
        console.warn('No se pudo inicializar Google Login:', error.message);
    }
};

window.handleGoogleCredential = async function handleGoogleCredential(googleResponse) {
    if (!googleResponse || !googleResponse.credential) {
        alert('Google no devolvió una credencial válida. Intentá nuevamente.');
        return;
    }
    try {
        const result = await apiRequest('/api/auth/google', {
            method: 'POST', tokenOverride: '', body: JSON.stringify({ credential: googleResponse.credential })
        });
        applyUserSession(result.user, result.token);
        showApp();
    } catch (error) {
        alert(error.message || 'No se pudo iniciar sesión con Google.');
    }
};

// ==================== VISUALIZACIÓN FÍSICA CON IA E INPAINT ====================
let physiqueNormalizedImageData = '';
let physiqueMaskHasMarks = false;
let physiqueMaskMode = 'paint';
let physiqueMaskIsDrawing = false;
let physiqueMaskLastPoint = null;
let physiquePreviewRequestId = 0;

function previewPhysiquePhoto(input) {
    const editor = document.getElementById('physiqueMaskEditor');
    const status = document.getElementById('physiqueStatus');
    const file = input && input.files && input.files[0];
    const requestId = ++physiquePreviewRequestId;
    physiqueNormalizedImageData = '';
    physiqueMaskHasMarks = false;
    if (editor) editor.style.display = 'none';
    if (status) status.textContent = '';
    const resultContainer = document.getElementById('physiqueResultContainer');
    if (resultContainer) resultContainer.style.display = 'none';
    if (!file) return;

    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        input.value = '';
        status.textContent = 'Elegí una imagen JPG, PNG o WebP.';
        return;
    }
    if (file.size > 5 * 1024 * 1024) {
        input.value = '';
        status.textContent = 'La fotografía original pesa más de 5 MB. Elegí una imagen más liviana.';
        return;
    }

    const reader = new FileReader();
    reader.onerror = () => { if (requestId === physiquePreviewRequestId) status.textContent = 'No se pudo leer la fotografía.'; };
    reader.onload = () => {
        if (requestId !== physiquePreviewRequestId) return;
        const sourceImage = new Image();
        sourceImage.onerror = () => { status.textContent = 'El navegador no pudo abrir esa imagen. Probá con otra foto JPG o PNG.'; };
        sourceImage.onload = () => {
            if (requestId !== physiquePreviewRequestId) return;
            // Stability Inpaint admite hasta 9.437.184 píxeles por imagen. Normalizamos
            // la fotografía en el navegador para que imagen y máscara tengan el mismo tamaño.
            const sourceWidth = sourceImage.naturalWidth;
            const sourceHeight = sourceImage.naturalHeight;
            const maxPixels = 8200000;
            const maxSide = 3400;
            const scale = Math.min(1, Math.sqrt(maxPixels / (sourceWidth * sourceHeight)), maxSide / Math.max(sourceWidth, sourceHeight));
            const width = Math.max(64, Math.floor(sourceWidth * scale));
            const height = Math.max(64, Math.floor(sourceHeight * scale));
            const normalizedCanvas = document.createElement('canvas');
            normalizedCanvas.width = width;
            normalizedCanvas.height = height;
            const normalizedContext = normalizedCanvas.getContext('2d', { alpha: false });
            normalizedContext.fillStyle = '#ffffff';
            normalizedContext.fillRect(0, 0, width, height);
            normalizedContext.drawImage(sourceImage, 0, 0, width, height);
            physiqueNormalizedImageData = normalizedCanvas.toDataURL('image/jpeg', 0.84);
            const maskImage = document.getElementById('physiqueMaskImage');
            maskImage.onload = () => {
                if (requestId !== physiquePreviewRequestId) return;
                const maskCanvas = document.getElementById('physiqueMaskCanvas');
                const overlayCanvas = document.getElementById('physiqueMaskOverlay');
                maskCanvas.width = width;
                maskCanvas.height = height;
                const maskContext = maskCanvas.getContext('2d', { willReadFrequently: false });
                maskContext.globalCompositeOperation = 'source-over';
                maskContext.fillStyle = '#000000';
                maskContext.fillRect(0, 0, width, height);
                overlayCanvas.width = width;
                overlayCanvas.height = height;
                overlayCanvas.getContext('2d').clearRect(0, 0, width, height);
                physiqueMaskHasMarks = false;
                editor.style.display = 'block';
                bindPhysiqueMaskDrawing();
                setPhysiqueMaskMode('paint');
                updatePhysiqueBrushSize(document.getElementById('physiqueBrushSize').value);
                status.textContent = 'Foto preparada. Marcá solo los músculos que querés modificar; las zonas sin pintar quedarán protegidas.';
            };
            maskImage.src = physiqueNormalizedImageData;
        };
        sourceImage.src = reader.result;
    };
    reader.readAsDataURL(file);
}

function bindPhysiqueMaskDrawing() {
    const overlay = document.getElementById('physiqueMaskOverlay');
    if (overlay.dataset.wired === 'true') return;
    overlay.dataset.wired = 'true';

    overlay.addEventListener('pointerdown', (event) => {
        if (!physiqueNormalizedImageData) return;
        event.preventDefault();
        physiqueMaskIsDrawing = true;
        physiqueMaskLastPoint = getPhysiqueMaskPoint(event);
        try { overlay.setPointerCapture(event.pointerId); } catch (_) {}
        drawPhysiqueMaskLine(physiqueMaskLastPoint, physiqueMaskLastPoint, true);
    });
    overlay.addEventListener('pointermove', (event) => {
        if (!physiqueMaskIsDrawing) return;
        event.preventDefault();
        const point = getPhysiqueMaskPoint(event);
        drawPhysiqueMaskLine(physiqueMaskLastPoint, point, false);
        physiqueMaskLastPoint = point;
    });
    const stopDrawing = () => {
        physiqueMaskIsDrawing = false;
        physiqueMaskLastPoint = null;
        if (physiqueMaskMode === 'erase') refreshPhysiqueMaskHasMarks();
    };
    overlay.addEventListener('pointerup', stopDrawing);
    overlay.addEventListener('pointercancel', stopDrawing);
    overlay.addEventListener('lostpointercapture', stopDrawing);
}

function getPhysiqueMaskPoint(event) {
    const canvas = document.getElementById('physiqueMaskOverlay');
    const rect = canvas.getBoundingClientRect();
    const scale = canvas.width / Math.max(1, rect.width);
    return {
        x: Math.max(0, Math.min(canvas.width, (event.clientX - rect.left) * scale)),
        y: Math.max(0, Math.min(canvas.height, (event.clientY - rect.top) * scale)),
        brushWidth: Math.max(2, Number(document.getElementById('physiqueBrushSize').value || 28) * scale)
    };
}

function drawPhysiqueMaskLine(from, to, isDot) {
    const maskCanvas = document.getElementById('physiqueMaskCanvas');
    const overlayCanvas = document.getElementById('physiqueMaskOverlay');
    const maskContext = maskCanvas.getContext('2d');
    const overlayContext = overlayCanvas.getContext('2d');
    const brushWidth = to.brushWidth;

    maskContext.globalCompositeOperation = 'source-over';
    maskContext.strokeStyle = physiqueMaskMode === 'paint' ? '#ffffff' : '#000000';
    maskContext.fillStyle = maskContext.strokeStyle;
    maskContext.lineCap = 'round';
    maskContext.lineJoin = 'round';
    maskContext.lineWidth = brushWidth;
    overlayContext.lineCap = 'round';
    overlayContext.lineJoin = 'round';
    overlayContext.lineWidth = brushWidth;

    if (physiqueMaskMode === 'paint') {
        overlayContext.globalCompositeOperation = 'source-over';
        overlayContext.strokeStyle = 'rgba(255, 50, 80, 0.48)';
        overlayContext.fillStyle = 'rgba(255, 50, 80, 0.48)';
        physiqueMaskHasMarks = true;
    } else {
        overlayContext.globalCompositeOperation = 'destination-out';
        // destination-out usa alfa como borrador; opaco para borrar la marca completa.
        overlayContext.strokeStyle = 'rgba(0, 0, 0, 1)';
        overlayContext.fillStyle = 'rgba(0, 0, 0, 1)';
    }

    if (isDot) {
        maskContext.beginPath();
        maskContext.arc(to.x, to.y, brushWidth / 2, 0, Math.PI * 2);
        maskContext.fill();
        if (physiqueMaskMode === 'paint') {
            overlayContext.beginPath();
            overlayContext.arc(to.x, to.y, brushWidth / 2, 0, Math.PI * 2);
            overlayContext.fill();
        } else {
            overlayContext.beginPath();
            overlayContext.arc(to.x, to.y, brushWidth / 2, 0, Math.PI * 2);
            overlayContext.fill();
        }
        return;
    }

    maskContext.beginPath();
    maskContext.moveTo(from.x, from.y);
    maskContext.lineTo(to.x, to.y);
    maskContext.stroke();
    overlayContext.beginPath();
    overlayContext.moveTo(from.x, from.y);
    overlayContext.lineTo(to.x, to.y);
    overlayContext.stroke();
}

function refreshPhysiqueMaskHasMarks() {
    const canvas = document.getElementById('physiqueMaskCanvas');
    if (!canvas || !canvas.width || !canvas.height) { physiqueMaskHasMarks = false; return; }
    const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let foundWhitePixel = false;
    for (let i = 0; i < data.length; i += 4) {
        if (data[i] > 127) { foundWhitePixel = true; break; }
    }
    physiqueMaskHasMarks = foundWhitePixel;
}

function setPhysiqueMaskMode(mode) {
    physiqueMaskMode = mode === 'erase' ? 'erase' : 'paint';
    const brushButton = document.getElementById('physiqueBrushButton');
    const eraserButton = document.getElementById('physiqueEraserButton');
    if (!brushButton || !eraserButton) return;
    brushButton.classList.toggle('active', physiqueMaskMode === 'paint');
    eraserButton.classList.toggle('active', physiqueMaskMode === 'erase');
    brushButton.setAttribute('aria-pressed', String(physiqueMaskMode === 'paint'));
    eraserButton.setAttribute('aria-pressed', String(physiqueMaskMode === 'erase'));
    const help = document.getElementById('physiqueMaskHelp');
    if (help) help.textContent = physiqueMaskMode === 'paint'
        ? 'Pincel activo: arrastrá para marcar en rojo las zonas que la IA puede modificar.'
        : 'Borrador activo: arrastrá sobre marcas rojas que no quieras enviar para editar.';
}

function updatePhysiqueBrushSize(value) {
    const size = document.getElementById('physiqueBrushSizeValue');
    if (size) size.textContent = String(value);
}

function clearPhysiqueMask() {
    const maskCanvas = document.getElementById('physiqueMaskCanvas');
    const overlayCanvas = document.getElementById('physiqueMaskOverlay');
    if (!maskCanvas || !overlayCanvas || !maskCanvas.width || !maskCanvas.height) return;
    const maskContext = maskCanvas.getContext('2d');
    maskContext.globalCompositeOperation = 'source-over';
    maskContext.fillStyle = '#000000';
    maskContext.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    overlayCanvas.getContext('2d').clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    physiqueMaskHasMarks = false;
    const status = document.getElementById('physiqueStatus');
    if (status) status.textContent = 'Se borraron las marcas. Pintá de nuevo las zonas del cuerpo que querés modificar.';
}

async function generatePhysiqueVisualization() {
    const input = document.getElementById('physiquePhoto');
    const consent = document.getElementById('physiqueConsent');
    const status = document.getElementById('physiqueStatus');
    const button = document.getElementById('physiqueGenerateButton');
    const container = document.getElementById('physiqueResultContainer');
    const file = input && input.files && input.files[0];
    if (!currentUser || !authToken) {
        status.textContent = 'Para usar esta función, iniciá sesión con Google o con una cuenta nueva de Calistium.';
        return;
    }
    if (!file || !physiqueNormalizedImageData) { status.textContent = 'Primero seleccioná una fotografía y esperá a que aparezca la herramienta de marcado.'; return; }
    if (!physiqueMaskHasMarks) { status.textContent = 'Marcá en rojo al menos una zona muscular para editar. Las zonas sin marcar se conservarán.'; return; }
    if (!consent.checked) { status.textContent = 'Necesitás aceptar el procesamiento externo de la fotografía y la máscara.'; return; }

    button.disabled = true;
    button.textContent = 'Generando…';
    status.textContent = 'Aplicando la edición solo a las zonas marcadas. Puede tardar un poco…';
    container.style.display = 'none';
    try {
        const maskData = document.getElementById('physiqueMaskCanvas').toDataURL('image/png');
        const result = await apiRequest('/api/ai/physique', {
            method: 'POST', body: JSON.stringify({ imageData: physiqueNormalizedImageData, maskData, consent: true })
        });
        const resultImage = document.getElementById('physiqueResult');
        const download = document.getElementById('physiqueDownload');
        resultImage.src = result.imageData;
        download.href = result.imageData;
        container.style.display = 'block';
        status.textContent = result.disclaimer || 'Visualización generada. Revisá que el resultado sea fiel a la fotografía original.';
        container.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (error) {
        status.textContent = error.message || 'No se pudo generar la imagen. Intentá nuevamente.';
    } finally {
        button.disabled = false;
        button.textContent = 'Generar visualización';
    }
}

// ==================== CATÁLOGO OFICIAL WGER ====================
async function loadWgerCatalog(forceRefresh = false) {
    if (exercisesLoaded && !forceRefresh) return exercises;
    if (exercisesLoadingPromise && !forceRefresh) return exercisesLoadingPromise;

    exercisesLoadingPromise = (async () => {
        const response = await apiRequest(`/api/exercises${forceRefresh ? '?refresh=1' : ''}`, { method: 'GET', tokenOverride: '' });
        const incoming = Array.isArray(response.exercises) ? response.exercises : [];
        exercises = incoming.map(item => ({
            ...item,
            id: Number(item.id),
            name: String(item.name || '').trim(),
            description: String(item.description || '').trim(),
            imageUrl: String(item.imageUrl || ''),
            equipment: Array.isArray(item.equipment) ? item.equipment : [],
            muscles: Array.isArray(item.muscles) ? item.muscles : [],
            musclesSecondary: Array.isArray(item.musclesSecondary) ? item.musclesSecondary : [],
            // Estos valores son reglas del juego, no datos atribuidos a wger.
            requiredLevel: 1,
            xpReward: 10,
            statBoost: 'strength'
        })).filter(item => Number.isInteger(item.id) && item.name);
        exercisesLoaded = true;
        return exercises;
    })().finally(() => { exercisesLoadingPromise = null; });
    return exercisesLoadingPromise;
}

function escapeHTML(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]);
}

const statLabels = { strength: 'Fuerza', endurance: 'Resistencia', agility: 'Agilidad', mentality: 'Mentalidad' };

    // Ejercicios expandidos con progresión equilibrada para cada nivel
// Equipamiento corregido con bonificaciones que NO son stats del personaje
const availableEquipment = [
    // BEGINNER (Nivel 1) - 5 equipos
    { 
        id: 1, 
        name: "Hidratación Pre-Entreno",
        category: "Nutrición", 
        description: "Bebe 500ml de agua 2 horas antes del entrenamiento para optimizar rendimiento",
        icon: "💧",
        unlockLevel: 2,
        bonus: "+5% XP en entrenamientos"
    },
    { 
        id: 2, 
        name: "Calentamiento Dinámico",
        category: "Calentamiento", 
        description: "5-10 minutos de movimientos articulares antes de entrenar",
        icon: "🔥",
        unlockLevel: 2,
        bonus: "Previene lesiones"
    },
    { 
        id: 3, 
        name: "Respiración Profunda",
        category: "Respiración", 
        description: "Exhala en el esfuerzo, inhala en la relajación del movimiento",
        icon: "🫁",
        unlockLevel: 2,
        bonus: "+10% Eficiencia"
    },
    { 
        id: 4, 
        name: "Descanso Activo",
        category: "Descanso", 
        description: "Entre series, camina suavemente en lugar de quedarte inmóvil",
        icon: "🚶",
        unlockLevel: 2,
        bonus: "Recuperación 25% más rápida"
    },
    { 
        id: 5, 
        name: "Estiramientos Dinámicos",
        category: "Técnica", 
        description: "Movilidad articular antes del entreno, estiramientos estáticos después",
        icon: "🤸",
        unlockLevel: 2,
        bonus: "+15% Flexibilidad"
    },
    
    // INTERMEDIATE (Nivel 2) - 5 equipos
    { 
        id: 6, 
        name: "Nutrición Post-Entreno",
        category: "Recuperación", 
        description: "Consume proteína y carbohidratos dentro de 30 min post-ejercicio",
        icon: "🍎",
        unlockLevel: 4,
        bonus: "+20% Ganancia muscular"
    },
    { 
        id: 7, 
        name: "Sueño Reparador",
        category: "Descanso", 
        description: "7-9 horas de sueño de calidad para recuperación muscular óptima",
        icon: "😴",
        unlockLevel: 4,
        bonus: "Regenera energía completa"
    },
    { 
        id: 8, 
        name: "Técnicas de Agarre",
        category: "Técnica", 
        description: "Varía los tipos de agarre para desarrollar fuerza integral",
        icon: "✋",
        unlockLevel: 4,
        bonus: "+30% Duración en colgados"
    },
    { 
        id: 9, 
        name: "Movilidad de Hombros",
        category: "Movilidad", 
        description: "Círculos de brazos y estiramientos de hombros antes de ejercicios superiores",
        icon: "🔄",
        unlockLevel: 4,
        bonus: "Previene lesiones de hombro"
    },
    { 
        id: 10, 
        name: "Intervalos de Descanso",
        category: "Descanso", 
        description: "30-90 segundos entre series según intensidad del ejercicio",
        icon: "⏰",
        unlockLevel: 4,
        bonus: "Optimiza rendimiento"
    },
    
    // ADVANCED (Nivel 3) - 5 equipos
    { 
        id: 11, 
        name: "Progresión Gradual",
        category: "Progresión", 
        description: "Aumenta dificultad solo cuando domines completamente el nivel actual",
        icon: "📈",
        unlockLevel: 6,
        bonus: "+50% XP por ejercicio nuevo"
    },
    { 
        id: 12, 
        name: "Calentamiento Específico",
        category: "Calentamiento", 
        description: "Calienta específicamente los músculos que vas a trabajar",
        icon: "🎯",
        unlockLevel: 6,
        bonus: "+25% Eficiencia muscular"
    },
    { 
        id: 13, 
        name: "Flexibilidad de Isquiotibiales",
        category: "Movilidad", 
        description: "Estiramientos de isquiotibiales mejoran el rango de movimiento en sentadillas",
        icon: "🦵",
        unlockLevel: 6,
        bonus: "Sentadillas más profundas"
    },
    { 
        id: 14, 
        name: "Periodización de Entrenamientos",
        category: "Planificación", 
        description: "Alterna intensidad alta y baja para evitar sobreentrenamiento",
        icon: "📅",
        unlockLevel: 6,
        bonus: "Evita estancamientos"
    },
    { 
        id: 15, 
        name: "Recuperación Activa",
        category: "Recuperación", 
        description: "Días de descanso con actividad ligera como caminata o yoga",
        icon: "🧘",
        unlockLevel: 6,
        bonus: "Acelera recuperación 40%"
    },
    
    // EXPERT (Nivel 4) - 5 equipos
    { 
        id: 16, 
        name: "Movilidad de Tobillos",
        category: "Movilidad", 
        description: "Mejora la movilidad de tobillos para sentadillas más profundas",
        icon: "🦶",
        unlockLevel: 8,
        bonus: "Desbloquea sentadilla perfecta"
    },
    { 
        id: 17, 
        name: "Fortalecimiento de Muñecas",
        category: "Técnica", 
        description: "Ejercicios específicos de muñeca antes de paradas de mano",
        icon: "💪",
        unlockLevel: 8,
        bonus: "Habilita paradas de mano"
    },
    { 
        id: 18, 
        name: "Técnica de Kipping",
        category: "Técnica", 
        description: "Usa el impulso del cuerpo de manera eficiente en ejercicios dinámicos",
        icon: "⚡",
        unlockLevel: 8,
        bonus: "Dominadas con impulso"
    },
    { 
        id: 19, 
        name: "Evaluación de Asimetría",
        category: "Evaluación", 
        description: "Identifica y corrige desbalances musculares entre lados del cuerpo",
        icon: "⚖️",
        unlockLevel: 8,
        bonus: "Corrige desbalances"
    },
    { 
        id: 20, 
        name: "Fuerza de Agarre Elite",
        category: "Técnica", 
        description: "Entrena específicamente el agarre para ejercicios de colgado avanzados",
        icon: "🤏",
        unlockLevel: 8,
        bonus: "Agarre inquebrantable"
    }
];

// Contenido de desarrollo personal
        const developmentLessons = [
            {
                title: "La Mentalidad del Guerrero: Forjando la Disciplina Interior",
                content: `
                    <h3>El Primer Paso hacia la Grandeza</h3>
                    <p>La disciplina no es castigo ni restricción. Es <strong>libertad</strong>. Es la habilidad de hacer lo correcto cuando nadie te está viendo, de levantarte cuando no tienes ganas, de seguir adelante cuando todo en ti quiere rendirse. La disciplina es el puente entre quien eres ahora y quien quieres llegar a ser.</p>
                    
                    <div class="quote-box">
                        "La disciplina es el puente entre metas y logros. Sin ella, los sueños permanecen como fantasías que nos consuelan pero nunca nos transforman."
                    </div>
                    
                    <h3>Los 4 Pilares de la Mentalidad Ganadora</h3>
                    <p><strong>1. Consistencia sobre Intensidad:</strong> Es mejor entrenar 20 minutos todos los días que 3 horas una vez por semana. La transformación real ocurre en la repetición constante de pequeñas acciones. Cada día que mantienes tu compromiso, tu cerebro fortalece las conexiones neuronales asociadas con la disciplina.</p>
                    
                    <p><strong>2. El Poder del "Todavía No":</strong> En lugar de decir "no puedo hacer muscle-ups", di "todavía no puedo hacer muscle-ups". Esa pequeña palabra cambia tu cerebro de un estado fijo a uno de crecimiento. Activa regiones cerebrales asociadas con la neuroplasticidad y el aprendizaje.</p>
                    
                    <p><strong>3. Abraza el Proceso:</strong> Los resultados son consecuencia, no el objetivo. Enamórate del proceso de mejora diaria. Cada repetición, cada día de entrenamiento, cada momento de resistencia mental te está forjando. El proceso es donde vives el 99% de tu tiempo - aprende a disfrutarlo.</p>
                    
                    <p><strong>4. La Regla del 1%:</strong> Mejorar solo un 1% cada día significa ser 37 veces mejor en un año. No necesitas cambios dramáticos, necesitas evolución constante. Esta regla funciona porque evita la resistencia mental a los grandes cambios y construye momentum sostenible.</p>
                    
                    <h3>Ejercicio Práctico: El Contrato Contigo Mismo</h3>
                    <p>Escribe un compromiso personal: "Yo, [tu nombre], me comprometo a [acción específica] todos los días durante los próximos 30 días, sin excepciones, porque mi palabra hacia mí mismo es sagrada." Firma y fecha. Este contrato activa el principio psicológico de consistencia.</p>
                `
            },
            {
                title: "El Arte de la Persistencia: Venciendo la Resistencia Mental",
                content: `
                    <h3>La Zona de Incomodidad es tu Zona de Crecimiento</h3>
                    <p>Tu cerebro está programado para mantenerte seguro, no para hacerte exitoso. Cada vez que intentas algo nuevo o desafiante, tu sistema límbico activará la respuesta de "lucha, huida o congelación". <strong>Esa resistencia es la señal de que vas por el buen camino.</strong> Es tu cerebro primitivo tratando de protegerte de un "peligro" que en realidad es tu evolución.</p>
                    
                    <div class="quote-box">
                        "El músculo crece bajo tensión. El carácter crece bajo presión. La grandeza emerge cuando decides que tu compromiso es más fuerte que tu comodidad."
                    </div>
                    
                    <h3>La Neurociencia de la Resistencia</h3>
                    <p>Cuando enfrentas resistencia, tu corteza prefrontal (área del cerebro responsable de las decisiones racionales) está luchando contra tu sistema límbico (cerebro emocional primitivo). El truco es reconocer que esta batalla es normal y temporal. La resistencia inicial es siempre la más fuerte - una vez que empiezas, el momentum trabaja a tu favor.</p>
                    
                    <h3>Estrategias Científicamente Probadas para Dominar la Persistencia</h3>
                    <p><strong>La Regla de los 5 Minutos:</strong> Cuando no tengas ganas de entrenar, comprométete solo a 5 minutos. Este técnica funciona porque engaña a tu sistema límbico - 5 minutos no se percibe como amenaza. Una vez que empiezas, la inercia y las endorfinas naturalmente extienden la sesión.</p>
                    
                    <p><strong>Visualización del Futuro Yo:</strong> Dedica 2 minutos cada mañana a visualizar vívidamente la versión de ti que quieres ser. Ve tu cuerpo fuerte, tu mente disciplinada, tu confianza inquebrantable. Tu cerebro no distingue entre una experiencia real y una vívidamente imaginada - ambas fortalecen las mismas redes neuronales.</p>
                    
                    <p><strong>El Sistema de Micro-Wins:</strong> Celebra cada pequeña victoria conscientemente. Hiciste una flexión más que ayer? Celebra durante 10 segundos. Te levantaste temprano? Reconócelo. Elegiste agua en lugar de soda? Agradécete. Estos micro-wins programan tu cerebro para asociar hábitos saludables con recompensas, liberando dopamina que refuerza el comportamiento.</p>
                    
                    <h3>El Protocolo Anti-Resistencia</h3>
                    <p>1. <strong>Reconoce</strong> la resistencia sin juzgarla: "Noto que no quiero entrenar"<br>
                    2. <strong>Recuerda</strong> tu identidad: "Soy una persona que honra sus compromisos"<br>
                    3. <strong>Reduce</strong> el compromiso: "Solo haré 5 minutos"<br>
                    4. <strong>Ejecuta</strong> inmediatamente antes de que tu mente racionalice más excusas</p>
                `
            },
            {
                title: "La Psicología del Éxito: Reprogramando tu Identidad",
                content: `
                    <h3>Tu Identidad Determina tus Acciones</h3>
                    <p>No dices "estoy tratando de estar en forma", dices "soy una persona atlética". No dices "debería comer mejor", dices "soy alguien que cuida su cuerpo como un templo". <strong>Cuando cambias tu identidad, tus acciones siguen automáticamente.</strong> Este es el nivel más profundo de cambio - no cambias lo que haces, cambias quien eres.</p>
                    
                    <div class="quote-box">
                        "No eres lo que piensas que eres. Eres lo que haces repetidamente. La excelencia no es un acto, sino un hábito grabado en tu identidad."
                    </div>
                    
                    <h3>El Poder de las Afirmaciones Basadas en Identidad</h3>
                    <p>Las afirmaciones tradicionales ("Voy a ser fuerte") son menos efectivas que las afirmaciones de identidad ("Soy una persona fuerte"). Tu cerebro subconsciente trabaja 24/7 para hacer que tu comportamiento sea consistente con tu identidad. Cambiar la identidad es cambiar el sistema operativo de tu vida.</p>
                    
                    <h3>Reprogramación Mental Práctica</h3>
                    <p><strong>Afirmaciones de Poder Matutinas:</strong> Cada mañana, frente al espejo, di con convicción total: "Soy una persona disciplinada. Soy fuerte física y mentalmente. Soy alguien que cumple sus compromisos. Soy imparable." Tu cerebro subconsciente no cuestiona lo que le dices con convicción - simplemente busca evidencia para confirmar esta nueva identidad.</p>
                    
                    <p><strong>El Diálogo Interno Ganador:</strong> Cambia tu narrativa interna constantemente. "Esto es muy difícil" → "Esto me está haciendo más fuerte". "No puedo" → "Estoy aprendiendo cómo". "Estoy cansado" → "Estoy desarrollando resistencia mental". Tu diálogo interno es literalmente la programación de tu realidad.</p>
                    
                    <p><strong>Ambiente de Éxito Total:</strong> Rodéate de recordatorios visuales de tu nueva identidad. Fotos de atletas que representan quien quieres ser, frases poderosas en lugares estratégicos, tu rutina de ejercicios visible, ropa deportiva preparada la noche anterior. Tu ambiente programa tu mente subconsciente las 24 horas del día.</p>
                    
                    <h3>La Técnica del Alter Ego</h3>
                    <p>Crea un alter ego para tus entrenamientos - una versión mejorada de ti con un nombre específico. Cuando entrenes, "activa" este alter ego. Muhammad Ali tenía "The Greatest", Kobe tenía "Black Mamba". Esta técnica permite acceder a recursos mentales que normalmente están bloqueados por limitaciones auto-impuestas.</p>
                `
            },
            {
                title: "La Filosofía del Guerrero Moderno: Antifragilidad Mental",
                content: `
                    <h3>Más Allá de la Resiliencia: Construyendo Antifragilidad</h3>
                    <p>Un guerrero no es alguien que nunca siente miedo o dolor. Un guerrero es alguien que siente miedo y actúa de todas formas. Que siente dolor y encuentra una forma de crecer. Que enfrenta la adversidad y se vuelve más fuerte. La antifragilidad va más allá de la resistencia - es la capacidad de mejorar bajo estrés.</p>
                    
                    <div class="quote-box">
                        "La fortaleza no viene de la capacidad física. Viene de una voluntad indomable que se forja en los momentos más difíciles y se templa en el fuego de la adversidad."
                    </div>
                    
                    <h3>Los 5 Principios del Guerrero Moderno</h3>
                    <p><strong>1. Responsabilidad Total:</strong> Eres 100% responsable de tu vida. No de lo que te pasa, sino de cómo respondes a lo que te pasa. Esta mentalidad te devuelve el poder completo sobre tu destino. Víctima o creador - no puedes ser ambos.</p>
                    
                    <p><strong>2. Antifragilidad Activa:</strong> No solo resistir los golpes, sino volverse más fuerte con cada desafío. Cada rechazo es información. Cada fracaso es educación. Cada día difícil es entrenamiento para tu carácter. El estrés controlado es el método de construcción de la naturaleza.</p>
                    
                    <p><strong>3. Visión Cristalina:</strong> Un guerrero sin visión es solo alguien con músculos. Define exactamente qué quieres, por qué lo quieres visceralmente, y qué estás dispuesto a sacrificar por ello. La claridad elimina la fricción mental y multiplica tu velocidad de ejecución.</p>
                    
                    <p><strong>4. Ejecución Implacable:</strong> Ideas sin acción son alucinaciones. Planes sin ejecución son entretenimiento mental. La diferencia entre los exitosos y los soñadores no es el conocimiento - es la acción consistente a pesar de las circunstancias, los sentimientos o los obstáculos.</p>
                    
                    <p><strong>5. Mejora Constante:</strong> Un guerrero nunca está "completo". Siempre está afilando su espada, fortaleciendo su mente, expandiendo sus habilidades. El momento que crees que ya "llegaste" es el momento que empiezas a declinar.</p>
                    
                    <h3>El Ritual del Guerrero Matutino</h3>
                    <p>Cada mañana, antes de revisar el teléfono o hablar con alguien, dedica 10 minutos a tu ritual de poder: 2 minutos de respiración profunda, 3 minutos visualizando tu día ideal, 5 minutos reafirmando tu identidad de guerrero. Este ritual programa tu estado mental para todo el día.</p>
                `
            },
            {
                title: "El Camino del Maestro: De Novato a Leyenda",
                content: `
                    <h3>La Transformación es un Proceso, No un Evento</h3>
                    <p>No te despiertas un día siendo fuerte. Te despiertas un día y te das cuenta de que eres fuerte. La transformación real ocurre en silencio, día tras día, repetición tras repetición, decisión tras decisión. Es como la formación de un diamante - requiere presión constante durante tiempo extenso.</p>
                    
                    <div class="quote-box">
                        "El maestro ha fallado más veces de las que el principiante ha intentado. La diferencia es que nunca dejó de intentar, nunca dejó de aprender, nunca dejó de evolucionar."
                    </div>
                    
                    <h3>Las 5 Etapas del Dominio Personal</h3>
                    <p><strong>Etapa 1 - El Despertar (Días 1-30):</strong> Te das cuenta de que quieres cambiar. La motivación es alta, pero la disciplina aún no está forjada. Tu entusiasmo es tu combustible principal. Aquí es donde la mayoría abandona cuando la novedad desaparece. La clave es crear sistemas, no depender solo de la motivación.</p>
                    
                    <p><strong>Etapa 2 - La Forja (Días 31-90):</strong> La motivación inicial se desvanece, pero empiezas a construir disciplina real. Los días difíciles te templan como el fuego templa el acero. Cada día que persistes a pesar de no "sentirte motivado" es un día que construyes músculo mental. Esta etapa separa a los guerreros de los soñadores.</p>
                    
                    <p><strong>Etapa 3 - El Impulso (Días 91-180):</strong> La disciplina se vuelve automática. Ya no necesitas motivación externa porque has desarrollado motivación intrínseca. Tus nuevos hábitos requieren menos energía mental porque se han convertido en parte de tu identidad. El momentum trabaja a tu favor.</p>
                    
                    <p><strong>Etapa 4 - El Refinamiento (Días 181-365):</strong> Comienzas a optimizar y perfeccionar. No solo haces los ejercicios, los dominas. No solo tienes disciplina, tienes sabiduría sobre cuándo empujar y cuándo recuperar. Desarrollas intuición sobre tu cuerpo y mente.</p>
                    
                    <p><strong>Etapa 5 - La Maestría (365+ días):</strong> No solo dominas tu cuerpo, dominas tu mente. Te conviertes en una fuerza imparable que inspira a otros a comenzar su propio viaje. Tu sola presencia eleva el estándar de quienes te rodean. Has transformado no solo tu físico, sino tu carácter completo.</p>
                    
                    <h3>El Secreto de los Maestros</h3>
                    <p>Los maestros entienden que cada día es tanto un final como un comienzo. Celebran el progreso de hoy y se preparan mentalmente para los desafíos de mañana. Nunca se sienten "completos" - siempre hay una montaña más alta que escalar, una versión mejor de sí mismos que crear.</p>
                `
            },
            {
                title: "El Poder de la Adversidad: Convirtiendo Obstáculos en Escalones",
                content: `
                    <h3>La Adversidad es tu Universidad Personal</h3>
                    <p>Cada obstáculo que enfrentas es una oportunidad disfrazada de problema. Cada "no" es información sobre cómo conseguir un "sí". Cada fracaso es una lección costosa que te ahorra errores futuros más caros. La adversidad no está ahí para detenerte - está ahí para prepararte para el siguiente nivel.</p>
                    
                    <div class="quote-box">
                        "El diamante no puede ser pulido sin fricción, ni el hombre perfeccionado sin adversidad. Lo que no te mata, literalmente te hace más fuerte si eliges aprender de ello."
                    </div>
                    
                    <h3>La Mentalidad del Alquimista Mental</h3>
                    <p>Un alquimista transforma metales comunes en oro. Un guerrero mental transforma problemas en poder, obstáculos en oportunidades, dolor en progreso. Esta transformación no es automática - requiere práctica consciente de reencuadrar cada experiencia negativa como material de construcción para tu fortaleza.</p>
                    
                    <h3>El Protocolo de Transformación de Adversidad</h3>
                    <p><strong>Paso 1 - Pausar y Respirar:</strong> Cuando enfrentas una adversidad, tu primera reacción es emocional. Antes de reaccionar, toma 3 respiraciones profundas. Esto activa tu corteza prefrontal y desactiva tu sistema límbico.</p>
                    
                    <p><strong>Paso 2 - Preguntar "¿Para qué?":</strong> En lugar de "¿Por qué me pasa esto?", pregunta "¿Para qué me sirve esto?" o "¿Qué puedo aprender de esto?". Esta simple pregunta cambia tu cerebro de modo víctima a modo aprendizaje.</p>
                    
                    <p><strong>Paso 3 - Buscar el Crecimiento:</strong> Identifica específicamente qué habilidad mental, física o emocional puedes desarrollar a través de este desafío. Cada adversidad viene con un regalo de fortaleza - tu trabajo es encontrarlo y desarrollarlo.</p>
                    
                    <p><strong>Paso 4 - Actuar desde la Fortaleza:</strong> No actúes desde el dolor, actúa desde el poder que el dolor te está ofreciendo desarrollar. Usa la adversidad como combustible para acciones más determinadas.</p>
                    
                    <h3>Los Tipos de Adversidad y sus Regalos</h3>
                    <p><strong>Adversidad Física:</strong> Te enseña resistencia, te muestra tus límites actuales y cómo expandirlos.<br>
                    <strong>Adversidad Mental:</strong> Desarrolla tu capacidad de concentración, resolución de problemas y paciencia.<br>
                    <strong>Adversidad Emocional:</strong> Fortalece tu inteligencia emocional y tu capacidad de mantener equilibrio interno.<br>
                    <strong>Adversidad Social:</strong> Te enseña independencia, autenticidad y la importancia de elegir tu círculo interno.</p>
                `
            },
            {
                title: "La Ciencia del Enfoque: Dominando tu Atención en la Era de Distracción",
                content: `
                    <h3>Tu Atención es tu Activo Más Valioso</h3>
                    <p>En un mundo diseñado para distraerte, tu capacidad de enfocar tu atención conscientemente es tu superpoder. Todo lo que logres en la vida será el resultado directo de dónde diriges tu atención de forma consistente. Las empresas más grandes del mundo están luchando por capturar tu atención - porque quien controla tu atención, controla tu vida.</p>
                    
                    <div class="quote-box">
                        "Donde va tu atención, va tu energía. Donde va tu energía, van tus resultados. El enfoque no es solo una habilidad - es el fundamento de toda grandeza."
                    </div>
                    
                    <h3>La Neurociencia del Enfoque Profundo</h3>
                    <p>Tu cerebro tiene dos redes principales: la Red de Modo por Defecto (que divaga y se distrae) y la Red de Control Ejecutivo (que se enfoca y ejecuta). El entrenamiento de enfoque fortalece la segunda y debilita la primera. Como cualquier músculo, el enfoque se desarrolla con práctica específica.</p>
                    
                    <h3>El Sistema de Enfoque Láser (Protocolo EFL)</h3>
                    <p><strong>E - Eliminar Distracciones:</strong> Identifica y elimina todo lo que compite por tu atención durante tus entrenamientos. Teléfono en otra habitación, notificaciones desactivadas, ambiente optimizado. Tu entorno físico programa tu estado mental.</p>
                    
                    <p><strong>F - Focalizar Intencionalmente:</strong> Antes de cada ejercicio, toma 10 segundos para establecer una intención específica: "En esta serie voy a sentir cada fibra muscular trabajando" o "Voy a mantener perfecta técnica en cada repetición". La intención consciente multiplica la efectividad.</p>
                    
                    <p><strong>L - Mantener la Línea de Atención:</strong> Cuando notes que tu mente divaga (y lo hará), suavemente regresa tu atención al presente sin juzgarte. Cada vez que haces esto, fortaleces tu "músculo de atención".</p>
                    
                    <h3>Técnicas Avanzadas de Enfoque</h3>
                    <p><strong>La Técnica del Foco Singular:</strong> Durante cada ejercicio, enfócate en UN solo elemento: la respiración, la contracción muscular, o la forma. Maestría es profundidad, no amplitud.</p>
                    
                    <p><strong>Intervalos de Atención:</strong> Comienza con períodos cortos de enfoque total (5-10 minutos) y gradualmente extiéndelos. Es mejor 10 minutos de enfoque perfecto que 60 minutos de atención dividida.</p>
                    
                    <p><strong>La Regla del Reset:</strong> Entre ejercicios, toma 30 segundos para "resetear" tu atención con respiración profunda. Esto previene la fatiga mental y mantiene la calidad del enfoque.</p>
                `
            },
            {
                title: "La Alquimia del Hábito: Construyendo Automatismos Poderosos",
                content: `
                    <h3>Los Hábitos son la Arquitectura del Éxito</h3>
                    <p>No eres lo que haces ocasionalmente, eres lo que haces consistentemente. Los hábitos son acciones que tu cerebro ha automatizado para ahorrar energía mental. El 95% de tus acciones diarias son hábitos - por eso cambiar hábitos cambia tu vida completa.</p>
                    
                    <div class="quote-box">
                        "Somos lo que hacemos repetidamente. La excelencia no es un acto, sino un hábito. Los ganadores no son personas especiales - son personas con hábitos especiales."
                    </div>
                    
                    <h3>La Neurociencia de la Formación de Hábitos</h3>
                    <p>Los hábitos se forman en los ganglios basales, una parte primitiva del cerebro. Una vez que un patrón de comportamiento se automatiza ahí, requiere mínima energía mental. Por eso puedes conducir un auto mientras piensas en otra cosa - conducir se volvió un hábito automatizado.</p>
                    
                    <h3>El Ciclo Dorado del Hábito (CDH)</h3>
                    <p><strong>1. Señal (Cue):</strong> Un disparador específico que inicia el hábito. Puede ser tiempo (6:00 AM), ubicación (gimnasio), emoción (estrés), o acción previa (levantarse de la cama).</p>
                    
                    <p><strong>2. Rutina:</strong> La acción específica que realizas. Debe ser lo suficientemente fácil que no requiera mucha fuerza de voluntad, especialmente al inicio.</p>
                    
                    <p><strong>3. Recompensa:</strong> Un beneficio que tu cerebro asocia con completar la rutina. Puede ser interno (sensación de logro) o externo (una recompensa que te das).</p>
                    
                    <h3>Estrategias Avanzadas para Construcción de Hábitos</h3>
                    <p><strong>Stacking de Hábitos:</strong> Conecta un nuevo hábito a uno existente. "Después de lavarme los dientes (hábito existente), haré 10 flexiones (nuevo hábito)". Tu cerebro usa el hábito existente como ancla.</p>
                    
                    <p><strong>La Regla del 2-Minutos:</strong> Cualquier hábito nuevo debe poder completarse en menos de 2 minutos. "Hacer ejercicio por 1 hora" se convierte en "ponerme la ropa deportiva". Una vez que el hábito se establece, puedes expandirlo.</p>
                    
                    <p><strong>Diseño del Ambiente:</strong> Haz que las señales de buenos hábitos sean obvias y las señales de malos hábitos sean invisibles. Deja tu ropa deportiva visible la noche anterior. Esconde las distracciones.</p>
                    
                    <p><strong>Tracking Visual:</strong> Usa un calendario para marcar cada día que completas tu hábito. Tu cerebro libera dopamina al ver la cadena de éxitos, motivándote a no romperla.</p>
                `
            },
            {
                title: "El Arte de la Recuperación: La Sabiduría del Descanso Activo",
                content: `
                    <h3>El Descanso no es Pereza - es Estrategia</h3>
                    <p>En una cultura obsesionada con el "hustle" constante, el descanso se percibe como debilidad. La realidad es exactamente opuesta: el descanso inteligente es la estrategia de los ganadores a largo plazo. Tu cuerpo se fortalece durante el descanso, no durante el entrenamiento. El entrenamiento es el estímulo, la recuperación es la adaptación.</p>
                    
                    <div class="quote-box">
                        "El guerrero sabio conoce que las batallas se ganan no solo con fuerza, sino con la sabiduría de saber cuándo luchar y cuándo recuperar fuerzas para la próxima batalla."
                    </div>
                    
                    <h3>Los 4 Pilares de la Recuperación Óptima</h3>
                    <p><strong>1. Sueño de Calidad:</strong> Durante el sueño profundo, tu cuerpo produce hormona de crecimiento, consolida memorias y repara tejidos. 7-9 horas de sueño de calidad no es lujo - es necesidad para el rendimiento óptimo.</p>
                    
                    <p><strong>2. Nutrición Estratégica:</strong> Tu cuerpo necesita proteína para reparar músculos, carbohidratos para reponer energía, y grasas saludables para optimizar hormonas. La ventana post-entrenamiento (30-60 minutos) es crítica para la recuperación.</p>
                    
                    <p><strong>3. Manejo del Estrés:</strong> El estrés crónico eleva el cortisol, que interfiere con la recuperación y el crecimiento muscular. Técnicas como meditación, respiración profunda, o tiempo en la naturaleza son herramientas de recuperación, no solo "relajación".</p>
                    
                    <p><strong>4. Movimiento Regenerativo:</strong> El descanso activo (caminar, yoga suave, estiramientos) mejora la circulación y acelera la eliminación de productos de desecho metabólico. Movimiento ≠ siempre intensidad.</p>
                    
                    <h3>Señales de que Necesitas Recuperación</h3>
                    <p>• Frecuencia cardíaca en reposo elevada por 2+ días<br>
                    • Fatiga persistente a pesar de suficiente sueño<br>
                    • Disminución en el rendimiento de entrenamientos<br>
                    • Irritabilidad o cambios de humor<br>
                    • Dolores musculares que duran más de 48-72 horas<br>
                    • Pérdida de motivación para entrenar</p>
                    
                    <h3>Protocolo de Recuperación Estratégica</h3>
                    <p>1. <strong>Evaluación:</strong> Identifica si necesitas recuperación activa o pasiva<br>
                    2. <strong>Acción:</strong> Implementa la estrategia correspondiente por 24-48 horas<br>
                    3. <strong>Monitoreo:</strong> Evalúa tus niveles de energía y motivación<br>
                    4. <strong>Ajuste:</strong> Modifica tu plan de entrenamiento según la respuesta</p>
                `
            },
            {
                title: "La Mentalidad de Crecimiento: Transformando Fracasos en Escalones",
                content: `
                    <h3>El Fracaso es el Precio de Entrada al Éxito</h3>
                    <p>Cada persona exitosa que admiras tiene una colección secreta de fracasos que nadie ve. El fracaso no es lo opuesto al éxito - es un ingrediente esencial del éxito. La diferencia entre los ganadores y los perdedores no es que unos fracasen y otros no, es cómo procesan e integran esos fracasos.</p>
                    
                    <div class="quote-box">
                        "No he fallado. Solo he encontrado 10,000 formas que no funcionan. Cada fracaso me acerca un paso más a la solución." - Thomas Edison
                    </div>
                    
                    <h3>La Mentalidad Fija vs. La Mentalidad de Crecimiento</h3>
                    <p><strong>Mentalidad Fija:</strong> "Soy malo para esto", "No tengo talento", "Si fuera para mí, ya habría resultado". Esta mentalidad ve las habilidades como fijas e inmutables.</p>
                    
                    <p><strong>Mentalidad de Crecimiento:</strong> "Todavía no soy bueno en esto", "Puedo mejorar con práctica", "Cada intento me enseña algo nuevo". Esta mentalidad ve las habilidades como desarrollables a través del esfuerzo y la estrategia correcta.</p>
                    
                    <h3>El Protocolo de Transformación del Fracaso</h3>
                    <p><strong>Paso 1 - Aceptación Sin Juicio:</strong> "Este resultado no fue el que esperaba" (sin etiquetas como "soy un fracaso").</p>
                    
                    <p><strong>Paso 2 - Extracción de Aprendizaje:</strong> "¿Qué información útil puedo extraer de esta experiencia?" Siempre hay al menos una lección valiosa.</p>
                    
                    <p><strong>Paso 3 - Ajuste de Estrategia:</strong> "¿Qué voy a hacer diferente la próxima vez?" El fracaso solo es válido si conduce a un cambio de estrategia.</p>
                    
                    <p><strong>Paso 4 - Acción Inmediata:</strong> "¿Cuál es el siguiente paso más pequeño que puedo tomar?" No permitas que el análisis se convierta en parálisis.</p>
                    
                    <h3>Reencuadrando el Vocabulario del Fracaso</h3>
                    <p>"Fallé" → "Obtuve información valiosa"<br>
                    "No puedo" → "Aún no he encontrado la forma correcta"<br>
                    "Es muy difícil" → "Esto requerirá que desarrolle nuevas habilidades"<br>
                    "No sirvo para esto" → "Esta habilidad necesita más práctica deliberada"</p>
                `
            },
            {
                title: "El Arte de la Paciencia: La Fuerza Silenciosa de los Campeones",
                content: `
                    <h3>La Paciencia no es Pasividad - es Poder Estratégico</h3>
                    <p>En una era de gratificación instantánea, la paciencia se ha convertido en un superpoder. La paciencia no significa esperar pasivamente - significa mantener acción consistente hacia metas a largo plazo a pesar de la ausencia de resultados inmediatos. Es la habilidad de plantar semillas sabiendo que el árbol tardará años en dar frutos.</p>
                    
                    <div class="quote-box">
                        "La paciencia es amarga, pero sus frutos son dulces. Los mejores resultados de la vida requieren tiempo para madurar, como el vino fino o la sabiduría profunda."
                    </div>
                    
                    <h3>La Neurociencia de la Gratificación Diferida</h3>
                    <p>El famoso experimento del malvavisco demostró que niños que podían esperar por una segunda golosía tenían mejores resultados académicos, relaciones más saludables y mayor éxito profesional décadas después. La habilidad de diferir gratificación es predictiva de éxito en casi todas las áreas de la vida.</p>
                    
                    <h3>Construyendo Músculo de Paciencia</h3>
                    <p><strong>Meditación de Paciencia:</strong> 10 minutos diarios observando tu respiración sin tratar de cambiarla. Cuando tu mente quiera acelerar o parar, simplemente observa esa impaciencia sin reaccionar.</p>
                    
                    <p><strong>Proyectos de Paciencia:</strong> Elige un proyecto que tarde meses en completar (aprender un idioma, dominar un ejercicio avanzado). Disfruta el proceso sin obsesionarte con el resultado final.</p>
                    
                    <p><strong>Micro-Esperas:</strong> Practica paciencia en situaciones cotidianas: esperar en fila sin revisar el teléfono, mantener silencio incómodo en conversaciones, contar hasta 10 antes de responder cuando estés frustrado.</p>
                    
                    <h3>El Poder Compuesto de la Paciencia</h3>
                    <p>Einstein llamó al interés compuesto "la octava maravilla del mundo". El mismo principio aplica al desarrollo personal: pequeñas mejoras consistentes aplicadas pacientemente durante tiempo produce resultados que parecen milagrosos pero son simplemente matemáticas. 1% mejor cada día = 37x mejor en un año.</p>
                `
            },
            {
                title: "La Fuerza Interior: Desarrollando Resistencia Mental Inquebrantable",
                content: `
                    <h3>La Fortaleza Mental se Construye, No se Nace</h3>
                    <p>La resistencia mental no es una cualidad misteriosa reservada para unos pocos elegidos. Es una habilidad desarrollable a través de práctica específica y deliberada. Como cualquier músculo, la fortaleza mental se desarrolla sometiéndola a estrés controlado y progresivo.</p>
                    
                    <div class="quote-box">
                        "El hierro forja hierro. La presión crea diamantes. La adversidad controlada construye carácter invencible. Tu mente es tu herramienta más poderosa - aprende a afilarla."
                    </div>
                    
                    <h3>Los 4 Componentes de la Resistencia Mental</h3>
                    <p><strong>1. Control Mental:</strong> La habilidad de dirigir tu atención conscientemente y mantenerla enfocada a pesar de distracciones internas o externas.</p>
                    
                    <p><strong>2. Confianza Inquebrantable:</strong> La creencia profunda en tu capacidad de encontrar soluciones y superar obstáculos, basada en evidencia acumulada de superación previa.</p>
                    
                    <p><strong>3. Compromiso Total:</strong> La dedicación completa a tus metas más importantes, mantenida incluso cuando la motivación fluctúa o desaparece temporalmente.</p>
                    
                    <p><strong>4. Desafío como Oportunidad:</strong> La habilidad de reencuadrar obstáculos como oportunidades de crecimiento y fortalecimiento, en lugar de amenazas a evitar.</p>
                    
                    <h3>Ejercicios de Fortalecimiento Mental</h3>
                    <p><strong>Duchas Frías Deliberadas:</strong> 2-3 minutos de agua fría al final de cada ducha. Respira profundo y mantén calma mental mientras tu cuerpo experimenta incomodidad controlada.</p>
                    
                    <p><strong>Ayunos de Comodidad:</strong> Períodos deliberados sin comodidades habituales (entretenimiento, snacks, sofá) para fortalecer tu capacidad de estar cómodo siendo incómodo.</p>
                    
                    <p><strong>Meditación de Observación:</strong> 20 minutos observando pensamientos y emociones sin reaccionar a ellos. Desarrolla la habilidad de ser el observador de tu experiencia interna, no la víctima.</p>
                    
                    <p><strong>Challenges Auto-Impuestos:</strong> Crea desafíos específicos que requieran persistencia mental (no quejarte por una semana, levantarte a la misma hora 30 días seguidos, no revisar redes sociales por un mes).</p>
                `
            },
            {
                title: "La Química del Momentum: Creando Impulso Imparable",
                content: `
                    <h3>El Momentum es la Diferencia Entre Lucha y Fluidez</h3>
                    <p>Hay dos estados en la vida: luchar contra la resistencia o surfear el momentum. El momentum hace que acciones que antes requerían enorme fuerza de voluntad se sientan naturales y automáticas. Crear momentum es el secreto para hacer que el progreso se sienta inevitable en lugar de imposible.</p>
                    
                    <div class="quote-box">
                        "Un objeto en movimiento tiende a permanecer en movimiento. Un cuerpo en entrenamiento tiende a seguir entrenando. Un hábito en acción tiende a perpetuarse. Momentum es física aplicada a la vida."
                    </div>
                    
                    <h3>La Anatomía del Momentum</h3>
                    <p><strong>Inicio (Días 1-7):</strong> Máxima resistencia, mínimo momentum. Cada acción requiere fuerza de voluntad consciente. Esta es la fase más crítica - la mayoría abandona aquí.</p>
                    
                    <p><strong>Acumulación (Días 8-21):</strong> La resistencia disminuye gradualmente. Empiezas a sentir menos fricción mental para realizar las acciones. Los resultados iniciales comienzan a aparecer.</p>
                    
                    <p><strong>Momentum (Días 22-66):</strong> Las acciones requieren menos energía mental. El hábito comienza a sentirse natural. Los resultados se acumulan visiblemente.</p>
                    
                    <p><strong>Automatización (Días 67+):</strong> El comportamiento se vuelve automático. Requiere más energía NO hacer la acción que hacerla. Has reprogramado tu identidad.</p>
                    
                    <h3>Estrategias para Acelerar el Momentum</h3>
                    <p><strong>La Regla del "No Cero":</strong> En días difíciles, haz la versión mínima posible pero nunca cero. Una flexión es mejor que cero flexiones. Mantiene el momentum alive.</p>
                    
                    <p><strong>Stacking de Victorias:</strong> Programa múltiples pequeñas victorias en secuencia rápida. Cada win libera dopamina que facilita el siguiente win.</p>
                    
                    <p><strong>Tracking Visual del Progreso:</strong> Mantén evidencia visual de tu progreso (fotos, números, gráficos). Tu cerebro necesita ver el momentum para mantenerlo.</p>
                    
                    <p><strong>Comunicación del Commitment:</strong> Comparte tus metas con personas que respetas. El accountability social multiplica el momentum interno.</p>
                `
            },
            {
                title: "El Poder de la Visualización: Programando el Éxito Antes de Vivirlo",
                content: `
                    <h3>Tu Cerebro No Distingue Entre Experiencia Real e Imaginada</h3>
                    <p>La visualización no es pensamiento positivo vacío - es entrenamiento mental basado en neurociencia. Cuando visualizas vívidamente una acción, las mismas neuronas se activan como si estuvieras realizando la acción físicamente. Los atletas olímpicos usan visualización como parte fundamental de su entrenamiento.</p>
                    
                    <div class="quote-box">
                        "Ve tu éxito en tu mente antes de verlo en tu realidad. Tu cerebro subconsciente trabajará incansablemente para hacer realidad las imágenes que alimentas consistentemente."
                    </div>
                    
                    <h3>La Ciencia de la Visualización Efectiva</h3>
                    <p>Estudios de neuroimagen muestran que la visualización vívida activa las mismas regiones cerebrales que la experiencia real. Esto fortalece las conexiones neuronales asociadas con la acción deseada, haciendo más probable que se ejecute exitosamente en la realidad.</p>
                    
                    <h3>El Protocolo de Visualización de Alto Rendimiento</h3>
                    <p><strong>1. Estado Relajado:</strong> Comienza con 2-3 minutos de respiración profunda para acceder al estado alfa cerebral, óptimo para visualización.</p>
                    
                    <p><strong>2. Perspectiva Primera Persona:</strong> Visualiza desde tus propios ojos, no como observador externo. Ve exactamente lo que verías si estuvieras realizando la acción.</p>
                    
                    <p><strong>3. Multi-Sensorial:</strong> Incluye todos los sentidos: qué ves, escuchas, sientes en tu piel, olor del ambiente, sensaciones musculares. Cuanto más vívido, más poderoso.</p>
                    
                    <p><strong>4. Emoción Auténtica:</strong> Siente las emociones que experimentarías al lograr el objetivo: orgullo, satisfacción, confianza. La emoción es el amplificador de la visualización.</p>
                    
                    <p><strong>5. Repetición Consistente:</strong> 10-15 minutos diarios, preferiblemente a la misma hora. La consistencia programa el subconsciente más efectivamente que sesiones largas esporádicas.</p>
                    
                    <h3>Tipos de Visualización Estratégica</h3>
                    <p><strong>Visualización de Proceso:</strong> Ve cada paso específico de tu entrenamiento ejecutado perfectamente.<br>
                    <strong>Visualización de Resultado:</strong> Imagina vívidamente cómo te verás y sentirás al alcanzar tu objetivo físico.<br>
                    <strong>Visualización de Obstáculos:</strong> Ensaya mentalmente cómo superarás desafíos específicos que podrías enfrentar.</p>
                `
            },
            {
                title: "La Sabiduría del Tiempo: Maximizando tu Recurso Más Valioso",
                content: `
                    <h3>El Tiempo es Democrático pero No Renovable</h3>
                    <p>Todos tenemos exactamente 24 horas al día, pero algunos logran resultados extraordinarios mientras otros luchan por lo básico. La diferencia no está en la cantidad de tiempo disponible, sino en cómo se invierte ese tiempo. El tiempo no es solo un recurso - es LA base sobre la cual se construye todo logro significativo.</p>
                    
                    <div class="quote-box">
                        "El tiempo es más valioso que el dinero. Puedes obtener más dinero, pero no puedes obtener más tiempo. Invierte tu tiempo, no lo gastes."
                    </div>
                    
                    <h3>La Matriz de Gestión de Tiempo del Guerrero</h3>
                    <p><strong>Cuadrante 1 - Urgente e Importante:</strong> Crisis, emergencias. Minimizar a través de prevención y preparación.</p>
                    
                    <p><strong>Cuadrante 2 - No Urgente pero Importante:</strong> Entrenamiento, planificación, desarrollo personal. AQUÍ es donde viven los ganadores. Maximiza este cuadrante.</p>
                    
                    <p><strong>Cuadrante 3 - Urgente pero No Importante:</strong> Interrupciones, algunas llamadas. Delegar o eliminar cuando sea posible.</p>
                    
                    <p><strong>Cuadrante 4 - No Urgente ni Importante:</strong> Entretenimiento pasivo, redes sociales mindless. Eliminar despiadadamente.</p>
                    
                    <h3>Técnicas de Maximización Temporal</h3>
                    <p><strong>Time-Blocking:</strong> Asigna bloques específicos de tiempo a actividades específicas. Tu entrenamiento tiene una cita sagrada en tu calendario - trátalo como una reunión con el CEO de tu vida.</p>
                    
                    <p><strong>La Regla del 80/20:</strong> El 80% de tus resultados viene del 20% de tus actividades. Identifica ese 20% crítico y obsesiónate con optimizarlo.</p>
                    
                    <p><strong>Batch Processing:</strong> Agrupa actividades similares. Revisa emails en bloques específicos, no constantemente. Entrena en sesiones concentradas, no fragmentadas.</p>
                    
                    <p><strong>La Técnica Pomodoro Modificada:</strong> 25 minutos de trabajo intenso, 5 de descanso. Pero para entrenamientos: 15 minutos de ejercicio enfocado, 2 minutos de transición/hidratación.</p>
                    
                    <h3>Audit de Tiempo Personal</h3>
                    <p>Durante una semana, registra exactamente cómo inviertes cada hora. La mayoría descubre que pierden 2-3 horas diarias en actividades de bajo valor. Esas horas recuperadas pueden transformar completamente tu progreso físico y mental.</p>
                `
            },
            {
                title: "El Arte de la Consistencia: La Fuerza Más Poderosa del Universo",
                content: `
                    <h3>La Consistencia Vence al Talento Cuando el Talento No es Consistente</h3>
                    <p>Einstein dijo que el interés compuesto es la fuerza más poderosa del universo. En el desarrollo personal, esa fuerza es la consistencia. Una persona promedio que actúa consistentemente superará a una persona talentosa que actúa esporádicamente. La consistencia transforma lo ordinario en extraordinario.</p>
                    
                    <div class="quote-box">
                        "No necesitas ser perfecto, necesitas ser consistente. La perfección es el enemigo del progreso, pero la consistencia es su mejor amigo."
                    </div>
                    
                    <h3>La Matemática de la Consistencia</h3>
                    <p>Una mejora del 1% diario durante un año = 37.78x mejor (1.01^365). Una regresión del 1% diario durante un año = 0.03x de tu nivel inicial (0.99^365). Esta matemática explica por qué algunas personas evolucionan dramáticamente mientras otras se estancan o declivan.</p>
                    
                    <h3>Los Pilares de la Consistencia Inquebrantable</h3>
                    <p><strong>1. Sistemas Sobre Metas:</strong> Las metas te dan dirección, los sistemas te dan progreso. "Quiero hacer 100 flexiones" es una meta. "Haré 5 flexiones más cada semana" es un sistema.</p>
                    
                    <p><strong>2. Identidad Sobre Comportamiento:</strong> "Soy una persona que entrena" es más poderoso que "voy a entrenar". La identidad impulsa comportamiento consistente automáticamente.</p>
                    
                    <p><strong>3. Proceso Sobre Resultados:</strong> Los resultados fluctúan, los procesos son controlables. Enfócate en hacer lo correcto consistentemente, los resultados son inevitables.</p>
                    
                    <p><strong>4. Progresión Sobre Perfección:</strong> Un entrenamiento mediocre es infinitamente mejor que no entrenar. La consistencia imperfecta supera a la perfección inconsistente.</p>
                    
                    <h3>Estrategias Anti-Inconsistencia</h3>
                    <p><strong>La Regla del Nunca Pierdo Dos Días:</strong> Si faltas un día, está bien. Si faltas dos días consecutivos, has roto el patrón. Protege la secuencia.</p>
                    
                    <p><strong>Redundancia de Sistemas:</strong> Ten múltiples triggers para el mismo hábito. Si falla uno, los otros mantienen la consistencia.</p>
                    
                    <p><strong>Pre-Compromiso:</strong> Estructura tu ambiente para que la consistencia sea la opción más fácil y la inconsistencia requiera esfuerzo extra.</p>
                    
                    <p><strong>Tracking Obsesivo:</strong> Lo que se mide se gestiona. Rastrea tu consistencia visualmente - tu cerebro odia romper cadenas de éxito.</p>
                `
            },
            {
                title: "El Dominio de la Respiración: El Poder Oculto Dentro de Ti",
                content: `
                    <h3>Tu Respiración es tu Superpoder Más Subestimado</h3>
                    <p>Respiras aproximadamente 23,000 veces al día, pero probablemente nunca has pensado en optimizar este proceso. La respiración consciente es la técnica de biohacking más poderosa disponible - gratis, accesible 24/7, y con efectos inmediatos en tu estado físico y mental.</p>
                    
                    <div class="quote-box">
                        "El que controla su respiración, controla su mente. El que controla su mente, controla su vida. Tu próxima respiración es tu oportunidad de transformación."
                    </div>
                    
                    <h3>La Ciencia de la Respiración Optimizada</h3>
                    <p>La respiración es el único proceso corporal que es tanto automático como voluntario. Esto la convierte en el puente perfecto entre tu sistema nervioso consciente y subconsciente. Cambiar tu patrón respiratorio cambia instantáneamente tu estado neurofisiológico.</p>
                    
                    <h3>Técnicas de Respiración para Rendimiento</h3>
                    <p><strong>Respiración de Caja (Box Breathing):</strong> Inhala 4 segundos, mantén 4, exhala 4, mantén 4. Repetir. Usado por Navy SEALs para mantener calma bajo presión extrema.</p>
                    
                    <p><strong>Respiración Wim Hof:</strong> 30 respiraciones rápidas y profundas, seguidas de retención. Aumenta energía, reduce estrés, mejora recuperación muscular.</p>
                    
                    <p><strong>Respiración 4-7-8:</strong> Inhala 4, mantén 7, exhala 8. Activa el sistema parasimpático, ideal para recuperación post-entrenamiento.</p>
                    
                    <p><strong>Respiración de Poder:</strong> Inhalaciones cortas y explosivas por la nariz, exhalaciones controladas por la boca. Aumenta alerta y energía pre-entrenamiento.</p>
                    
                    <h3>Integración en el Entrenamiento</h3>
                    <p><strong>Pre-Entrenamiento:</strong> 5 minutos de respiración energizante para preparar el sistema nervioso.</p>
                    
                    <p><strong>Durante el Ejercicio:</strong> Respiración sincronizada con movimiento - exhalar en el esfuerzo, inhalar en la relajación.</p>
                    
                    <p><strong>Post-Entrenamiento:</strong> 3 minutos de respiración calmante para activar recuperación parasimpática.</p>
                    
                    <p><strong>Entre Series:</strong> Respiración controlada en lugar de jadeo caótico - mantiene calidad de oxigenación y enfoque mental.</p>
                `
            },
            {
                title: "La Filosofía del Progreso: Midiendo lo que Realmente Importa",
                content: `
                    <h3>No Puedes Mejorar lo que No Mides</h3>
                    <p>El progreso real es frecuentemente invisible a simple vista. Tu peso puede fluctuar, tu ánimo puede cambiar, pero si no tienes métricas objetivas de progreso, fácilmente caerás en la ilusión del estancamiento. Los datos transforman percepciones subjetivas en realidad objetiva.</p>
                    
                    <div class="quote-box">
                        "El progreso es a menudo silencioso e invisible hasta que de repente se vuelve obvio e innegable. Mide todo, celebra cada milímetro de avance."
                    </div>
                    
                    <h3>Métricas de Progreso Multi-Dimensional</h3>
                    <p><strong>Métricas Físicas:</strong> Repeticiones, tiempo, resistencia, fuerza relativa, flexibilidad, medidas corporales. Los números no mienten.</p>
                    
                    <p><strong>Métricas de Rendimiento:</strong> Calidad de sueño, niveles de energía, frecuencia cardíaca en reposo, velocidad de recuperación entre entrenamientos.</p>
                    
                    <p><strong>Métricas Mentales:</strong> Consistencia de hábitos, resistencia a procrastinación, capacidad de concentración, gestión de estrés, confianza auto-reportada.</p>
                    
                    <p><strong>Métricas de Estilo de Vida:</strong> Adherencia a rutina, calidad nutricional, tiempo de pantalla, actividades de desarrollo personal completadas.</p>
                    
                    <h3>El Sistema de Tracking del Guerrero</h3>
                    <p><strong>Tracking Diario (2 minutos):</strong> Energía (1-10), adherencia a rutina (sí/no), estado de ánimo general (1-10).</p>
                    
                    <p><strong>Tracking Semanal (10 minutos):</strong> Progreso en ejercicios clave, peso corporal, medidas, evaluación semanal de metas.</p>
                    
                    <p><strong>Tracking Mensual (30 minutos):</strong> Análisis de tendencias, ajuste de estrategias, establecimiento de nuevas metas progresivas.</p>
                    
                    <p><strong>Tracking Trimestral (60 minutos):</strong> Evaluación profunda de progreso, celebración de logros, redefinición de visión a largo plazo.</p>
                    
                    <h3>La Psicología del Progreso Visible</h3>
                    <p>Tu cerebro está diseñado para notar problemas, no progreso. Hacer visible tu progreso a través del tracking combate esta tendencia natural y mantiene motivación alta durante plateaus inevitables.</p>
                `
            },
            {
                title: "El Legado del Guerrero: Más Allá del Cuerpo Perfecto",
                content: `
                    <h3>El Verdadero Éxito Trasciende lo Físico</h3>
                    <p>Al final, este viaje no es realmente sobre músculos, fuerza o apariencia física. Es sobre quién te conviertes en el proceso. Los músculos son el efecto secundario - el verdadero producto es el carácter inquebrantable, la disciplina automática, la confianza genuina que desarrollas.</p>
                    
                    <div class="quote-box">
                        "Entrenas tu cuerpo para transformar tu mente. Transformas tu mente para impactar tu mundo. Tu legado no es lo fuerte que eres, sino cuántos otros inspiraste a descubrir su propia fuerza."
                    </div>
                    
                    <h3>Los Verdaderos Regalos del Entrenamiento</h3>
                    <p><strong>Disciplina Transferible:</strong> La disciplina que desarrollas en el gimnasio se transfiere automáticamente a todas las áreas de tu vida - trabajo, relaciones, finanzas, crecimiento personal.</p>
                    
                    <p><strong>Confianza Genuina:</strong> La confianza que viene de superar desafíos reales es indestructible. No es arrogancia basada en comparación - es certeza basada en evidencia personal.</p>
                    
                    <p><strong>Resistencia Mental:</strong> Cada día que entrenas cuando no tienes ganas, cada serie que completas cuando quieres parar, cada meta que persigues cuando otros se rinden - todo esto construye una mentalidad que ninguna adversidad externa puede quebrar.</p>
                    
                    <p><strong>Modelo para Otros:</strong> Tu transformación se convierte en una invitación silenciosa para que otros comiencen su propio viaje. Sin predicar ni forzar, tu ejemplo demuestra que el cambio real es posible.</p>
                    
                    <h3>Construyendo un Legado Duradero</h3>
                    <p>Tu legado no se mide en PRs personales o medallas - se mide en las vidas que tocas, la inspiración que generas, y el estándar que estableces para las generaciones que vienen. Cada persona que decides vivir a su máximo potencial porque vio tu ejemplo es parte de tu legado eterno.</p>
                    
                    <h3>El Círculo de Influencia Expandido</h3>
                    <p><strong>Familia:</strong> Tus hijos ven que la disciplina es normal, que cuidar el cuerpo es importante, que los compromisos se honran.</p>
                    
                    <p><strong>Comunidad:</strong> Tu energía elevada, confianza genuina y ejemplo de perseverancia eleva a todos los que te rodean.</p>
                    
                    <p><strong>Mundo:</strong> En un planeta lleno de excusas y mediocridad, cada persona que vive su potencial completo es un acto de rebelión y esperanza.</p>
                    
                    <p>Al final, el entrenamiento físico es una metáfora perfecta para la vida: requiere mostrar cuando no tienes ganas, persistir cuando es difícil, y creer en un futuro mejor cuando la evidencia presente sugiere lo contrario. Estas habilidades, una vez dominadas en el contexto del fitness, se convierten en tu superpoder para todas las áreas de la existencia.</p>
                `
            },
            {
                title: "El Arte de la Automotivación: Siendo tu Propio Coach Inspiracional",
                content: `
                    <h3>La Motivación Externa es un Invitado Temporal</h3>
                    <p>Esperar motivación externa es como esperar que alguien más venga a vivir tu vida por ti. La motivación verdadera y sostenible debe generarse desde adentro. Debes convertirte en tu propio coach más inspirador, tu propio líder más convincente, tu propio sistema de apoyo más confiable.</p>
                    
                    <div class="quote-box">
                        "La automotivación no es un sentimiento que esperas - es una habilidad que desarrollas. Es el arte de encender tu propio fuego interno cuando el mundo exterior está frío."
                    </div>
                    
                    <h3>La Anatomía de la Automotivación</h3>
                    <p>La automotivación tiene tres componentes: propósito claro (por qué), visión vívida (hacia dónde), y sistema de refuerzo (cómo mantenerla). Sin estos tres elementos trabajando en armonía, dependes de factores externos para tu impulso interno.</p>
                    
                    <h3>Técnicas de Automotivación Avanzada</h3>
                    <p><strong>El Diálogo Interno del Campeón:</strong> Cambia conscientemente tu narrativa interna. "No puedo levantarme" → "Soy más fuerte que mi comodidad". "Esto es muy duro" → "Esto me está forjando". "No tengo tiempo" → "Siempre hay tiempo para las prioridades reales".</p>
                    
                    <p><strong>La Técnica del Futuro Yo Orgulloso:</strong> Antes de cada entrenamiento, visualiza a tu yo del futuro mirando hacia atrás con orgullo por esta decisión específica. ¿Qué te diría ese futuro yo sobre la importancia de este momento?</p>
                    
                    <p><strong>El Sistema de Recompensas Internas:</strong> Crea rituales de celebración personal para cada pequeño logro. Un momento de gratitud profunda, una sonrisa consciente, un reconocimiento interno. Tu cerebro necesita feedback positivo para mantener comportamientos deseados.</p>
                    
                    <p><strong>La Playlist Mental Personal:</strong> Desarrolla un repertorio de frases, imágenes mentales, y recordatorios que instantáneamente eleven tu estado. "Soy imparable", "Cada rep cuenta", "Mi futuro yo me está observando". Tenlas listas para momentos de baja motivación.</p>
                    
                    <h3>Construyendo Motivación Sostenible</h3>
                    <p>La motivación sostenible viene de conectar acciones presentes con valores profundos y visión de futuro. No entrenas solo por músculos - entrenas por el carácter que desarrollas, la confianza que construyes, el ejemplo que estableces. Cuando entiendes el "para qué" más profundo, el "cómo" se vuelve más fácil.</p>
                `
            },
            {
                title: "La Psicología del Dolor: Transformando Incomodidad en Crecimiento",
                content: `
                    <h3>El Dolor es Información, No Enemigo</h3>
                    <p>Existe una diferencia fundamental entre dolor destructivo (lesión, sobreentrenamiento) y dolor constructivo (fatiga muscular, incomodidad del crecimiento). Aprender a distinguir entre ambos y abrazar el segundo es esencial para el progreso sostenible. El dolor constructivo es el precio de entrada a una versión superior de ti mismo.</p>
                    
                    <div class="quote-box">
                        "El músculo crece en la incomodidad. El carácter se forja en la adversidad. La fortaleza emerge cuando decides que tu crecimiento es más importante que tu comodidad."
                    </div>
                    
                    <h3>Reencuadrando la Relación con la Incomodidad</h3>
                    <p>Tu cuerpo está diseñado para mantenerte vivo, no para hacerte excepcional. Cada vez que sales de tu zona de confort, tu sistema nervioso interpreta esto como una amenaza potencial. Entender esta respuesta biológica te ayuda a no tomarla personalmente - es solo tu cuerpo haciendo su trabajo.</p>
                    
                    <h3>Técnicas para Dominar la Incomodidad</h3>
                    <p><strong>Respiración a través del Dolor:</strong> Cuando sientes fatiga muscular, enfócate en respiración lenta y profunda. Esto oxigena mejor los músculos y calma el sistema nervioso que está interpretando la incomodidad como alarma.</p>
                    
                    <p><strong>Separación Observacional:</strong> "Noto que hay sensación de ardor en mis piernas" vs "Mis piernas están matándome". La primera es observación objetiva, la segunda es drama subjetivo. La observación te da poder, el drama te quita poder.</p>
                    
                    <p><strong>La Técnica del "Y Sin Embargo":</strong> "Siento fatiga Y SIN EMBARGO continúo", "Esto es incómodo Y SIN EMBARGO soy más fuerte que mi incomodidad". Esta frase acepta la realidad presente mientras afirma tu capacidad de transcenderla.</p>
                    
                    <p><strong>Graduación de Incomodidad:</strong> En una escala del 1-10, identifica tu nivel actual de incomodidad. Esto activa tu corteza prefrontal (pensamiento racional) y reduce la activación del sistema límbico (respuesta emocional primitiva).</p>
                    
                    <h3>La Zona de Crecimiento Óptimo</h3>
                    <p>El crecimiento ocurre en la intersección entre desafío y capacidad. Muy poco desafío = estancamiento. Demasiado desafío = lesión o agotamiento. El arte está en calibrar consistentemente esa zona dorada donde te sientes desafiado pero no abrumado.</p>
                `
            },
            {
                title: "El Dominio de la Energía: Optimizando tu Recurso Vital",
                content: `
                    <h3>La Energía es Más Valiosa que el Tiempo</h3>
                    <p>Puedes tener todo el tiempo del mundo, pero sin energía, ese tiempo es inútil. La gestión de energía es más crítica que la gestión de tiempo. Una hora con energía alta vale más que tres horas con energía baja. Optimizar tu energía es optimizar tu vida.</p>
                    
                    <div class="quote-box">
                        "La energía es la divisa de la vida. Los ricos en energía pueden comprar tiempo de calidad, experiencias profundas, y resultados extraordinarios."
                    </div>
                    
                    <h3>Los 4 Tipos de Energía</h3>
                    <p><strong>Energía Física:</strong> La base de todo lo demás. Sin energía física, tu capacidad mental, emocional y espiritual se ve comprometida. El ejercicio no consume energía física - la genera.</p>
                    
                    <p><strong>Energía Mental:</strong> Tu capacidad de concentración, creatividad y resolución de problemas. Se agota con decisiones constantes y se restaura con descanso mental y actividades que fluyen naturalmente.</p>
                    
                    <p><strong>Energía Emocional:</strong> Tu capacidad de mantener estados emocionales positivos y resilientes. Se nutre de relaciones auténticas, propósito claro, y gratitud práctica.</p>
                    
                    <p><strong>Energía Espiritual:</strong> Tu conexión con algo más grande que tú mismo. Se alimenta de propósito, valores alineados, y momentos de trascendencia.</p>
                    
                    <h3>Protocolo de Optimización Energética</h3>
                    <p><strong>Audit Energético:</strong> Durante una semana, registra tus niveles de energía cada 2 horas (1-10). Identifica patrones: qué actividades te energizan vs. cuáles te drenan, cuándo son tus picos naturales de energía, qué factores correlacionan con alta/baja energía.</p>
                    
                    <p><strong>Eliminación de Energy Vampires:</strong> Identifica y elimina o minimiza actividades, personas, o ambientes que consistentemente drenan tu energía sin proporcionar valor proporcional.</p>
                    
                    <p><strong>Inversión en Energy Boosters:</strong> Identifica y maximiza actividades que consistentemente aumentan tu energía: ejercicio, tiempo en naturaleza, conversaciones profundas, aprendizaje, música inspiradora.</p>
                    
                    <p><strong>Ritmos Circadianos Optimizados:</strong> Alinea tus actividades más importantes con tus picos naturales de energía. La mayoría de personas tienen picos a media mañana y tarde temprana.</p>
                    
                    <h3>La Energía Como Inversión Compuesta</h3>
                    <p>Cada elección que haces o aumenta o disminuye tu energía futura. Entrenar puede ser agotador en el momento, pero aumenta tu energía baseline permanentemente. Ver TV puede ser relajante temporalmente, pero disminuye tu energía a largo plazo.</p>
                `
            },
            {
                title: "La Filosofía del Límite: Expandiendo lo que Creías Posible",
                content: `
                    <h3>Tus Límites son Más Mentales que Físicos</h3>
                    <p>La mayoría de los límites que experimentas no son límites reales de tu cuerpo - son límites de tu mente. Tu cerebro está programado para detenerte al 40% de tu capacidad real como mecanismo de supervivencia. Los atletas de élite han aprendido a acceder al 60% restante a través del entrenamiento mental.</p>
                    
                    <div class="quote-box">
                        "El cuerpo logra lo que la mente cree. Si expandes tu definición de lo posible, expandirás automáticamente tu realidad de lo actual."
                    </div>
                    
                    <h3>La Neurociencia de los Límites Auto-Impuestos</h3>
                    <p>Tu cerebro utiliza experiencias pasadas para predecir capacidades futuras. Si nunca has hecho 20 flexiones, tu mente subconsciente "sabe" que no puedes. Esta predicción se convierte en una profecía auto-cumplida que limita tu esfuerzo real antes de alcanzar tu límite físico real.</p>
                    
                    <h3>Técnicas para Expansión de Límites</h3>
                    <p><strong>La Técnica del "Solo Una Más":</strong> Cuando sientas que has alcanzado tu límite, haz exactamente una repetición más. No pienses en 5 más - solo una. Esta técnica engaña a tu mente y expande gradualmente tu definición de capacidad.</p>
                    
                    <p><strong>Micro-Expansiones Sistemáticas:</strong> Aumenta tu "límite" en incrementos tan pequeños que tu mente no los perciba como amenazas. Si haces 10 flexiones, intenta 11 la próxima vez, no 15.</p>
                    
                    <p><strong>Reframing del Límite:</strong> Cambia "No puedo más" por "Esta es mi capacidad actual". El primero es definitivo, el segundo es temporal y expandible.</p>
                    
                    <p><strong>Estados de Flujo Inducidos:</strong> Usa música, visualización, o compañía de entrenamiento para entrar en estados donde tu mente analítica se aquieta y accedes a más de tu capacidad física real.</p>
                    
                    <h3>La Diferencia Entre Límites Reales y Percibidos</h3>
                    <p><strong>Límites Reales:</strong> Dolor agudo, mareo, imposibilidad física genuina. Respétalos.<br>
                    <strong>Límites Percibidos:</strong> "No puedo", fatiga generalizada, ganas de parar. Estos son negociables y expandibles con técnica apropiada.</p>
                    
                    <h3>El Protocolo de Expansión Gradual</h3>
                    <p>1. Identifica tu límite actual percibido<br>
                    2. Planea expandirlo en 5-10%<br>
                    3. Usa técnicas mentales para acceder a esa expansión<br>
                    4. Celebra el nuevo límite establecido<br>
                    5. Repite el ciclo semanalmente</p>
                `
            },
            {
                title: "El Poder de la Comunidad: La Fuerza Multiplicadora del Apoyo",
                content: `
                    <h3>Nadie Construye Grandeza en Soledad</h3>
                    <p>Detrás de cada transformación extraordinaria hay una red de apoyo, aunque a veces sea invisible. Los humanos somos criaturas sociales - nos elevamos o descendemos al nivel de quienes nos rodean. Tu círculo interno determinará más tu éxito que tu capacidad individual.</p>
                    
                    <div class="quote-box">
                        "Si quieres ir rápido, ve solo. Si quieres llegar lejos, ve acompañado. La grandeza sostenible siempre es un esfuerzo de equipo, aunque tengas que ensamblar ese equipo conscientemente."
                    </div>
                    
                    <h3>Los Círculos de Influencia</h3>
                    <p><strong>Círculo Interior (1-3 personas):</strong> Tu núcleo de apoyo incondicional. Familia cercana, mejor amigo, mentor. Estas personas te aman independientemente de tus logros pero te desafían a ser mejor.</p>
                    
                    <p><strong>Círculo de Crecimiento (5-8 personas):</strong> Compañeros de viaje que comparten valores similares y metas complementarias. Se apoyan mutuamente, comparten recursos, y celebran éxitos juntos.</p>
                    
                    <p><strong>Círculo de Inspiración (10-15 personas):</strong> Modelos a seguir, mentores, personas que han logrado lo que tú aspiras. Pueden ser conocidos personales o figuras públicas que estudias y emulaes.</p>
                    
                    <p><strong>Círculo de Impacto (ilimitado):</strong> Personas a quienes tu ejemplo influencia positivamente. Tu progreso les da permiso para creer en su propio potencial.</p>
                    
                    <h3>Construyendo tu Ecosistema de Éxito</h3>
                    <p><strong>Audit Social:</strong> Evalúa honestamente si las personas con las que pasas más tiempo te elevan o te limitan. ¿Te inspiran a ser mejor? ¿Apoyan tus metas? ¿Comparten valores de crecimiento?</p>
                    
                    <p><strong>Búsqueda Intencional:</strong> Busca activamente comunidades donde estén las personas que quieres emular. Gimnasios serios, grupos de desarrollo personal, comunidades en línea de fitness, eventos deportivos.</p>
                    
                    <p><strong>Contribución Generosa:</strong> Ofrece valor antes de pedirlo. Ayuda a otros en su viaje, comparte conocimiento, celebra éxitos ajenos. La reciprocidad construye relaciones duraderas.</p>
                    
                    <p><strong>Accountability Partners:</strong> Encuentra alguien con quien compartir metas y reportar progreso regularmente. El compromiso social multiplica la adherencia personal.</p>
                    
                    <h3>Navegando la Resistencia Social</h3>
                    <p>Cuando empiezas a cambiar, algunas personas en tu vida pueden resistir tu transformación (consciente o inconscientemente) porque tu crecimiento cuestiona sus propias elecciones. Mantente compasivo pero firme en tu dirección.</p>
                `
            }
        ];

// ==================== FUNCIONES DE NAVEGACIÓN ====================

function showRegister() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('registerScreen').style.display = 'flex';
}

function showLogin() {
    document.getElementById('registerScreen').style.display = 'none';
    document.getElementById('loginScreen').style.display = 'flex';
}

function showApp() {
    document.getElementById('loginScreen').style.display = 'none';
    document.getElementById('registerScreen').style.display = 'none';
    document.getElementById('appScreen').style.display = 'block';
    
    // Actualizar email en el botón de cuenta
    if (currentUser && currentUser.email) {
        const emailDisplay = document.getElementById('userEmailDisplay');
        if (emailDisplay) {
            emailDisplay.textContent = currentUser.email.split('@')[0];
        }
    }
    
    updateUI();
    loadExercises();
    loadEquipment();
    loadDevelopmentContent();
    checkForNewAchievements();
}

// ==================== FUNCIONES DE UI ====================

function updateUI() {
    document.getElementById('welcomeText').textContent = `Hola ${currentUser.name}, preparado para sufrir`;
    document.getElementById('levelBadge').textContent = `Nivel ${gameData.level}`;
    document.getElementById('currentXP').textContent = gameData.xp;
    document.getElementById('maxXP').textContent = gameData.maxXP;
    document.getElementById('xpFill').style.width = `${(gameData.xp / gameData.maxXP) * 100}%`;
    
    // Actualizar stats expandidos
    document.getElementById('strengthStat').textContent = gameData.strength;
    document.getElementById('enduranceStat').textContent = gameData.endurance;
    document.getElementById('agilityStat').textContent = gameData.agility;
    document.getElementById('mentalityStat').textContent = gameData.mentality;
    
    updateProfilePhotoUI();
    const adminBadge = document.getElementById('adminDemoBadge');
    if (adminBadge) adminBadge.style.display = currentUser && currentUser.role === 'admin' ? 'inline-flex' : 'none';
    renderAchievementsPanel();
}

function updateProfilePhotoUI() {
    const img = document.getElementById('profilePhoto');
    if (!img) return;
    const photo = currentUser && currentUser.profilePhoto;
    img.src = photo || './avatar-placeholder.svg';
    img.alt = currentUser && currentUser.name ? `Foto de perfil de ${currentUser.name}` : 'Foto de perfil';
}

async function saveProfilePhotoFile(input) {
    const file = input && input.files && input.files[0];
    const status = document.getElementById('profilePhotoStatus');
    if (!file) return;
    if (!currentUser || !authToken) {
        status.textContent = 'Iniciá sesión para guardar tu foto de perfil.';
        input.value = '';
        return;
    }
    if (!['image/jpeg', 'image/png', 'image/webp'].includes(file.type)) {
        status.textContent = 'Elegí una imagen JPG, PNG o WebP.';
        input.value = '';
        return;
    }
    if (file.size > 2 * 1024 * 1024) {
        status.textContent = 'La foto de perfil debe pesar 2 MB o menos.';
        input.value = '';
        return;
    }
    status.textContent = 'Guardando tu foto en tu cuenta…';
    try {
        const imageData = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('No se pudo leer la foto.'));
            reader.readAsDataURL(file);
        });
        const result = await apiRequest('/api/profile/photo', {
            method: 'PUT', body: JSON.stringify({ imageData })
        });
        currentUser.profilePhoto = result.profilePhoto || imageData;
        updateProfilePhotoUI();
        status.textContent = 'Foto de perfil guardada en tu cuenta.';
    } catch (error) {
        status.textContent = error.message || 'No se pudo guardar la foto. Intentá nuevamente.';
    } finally {
        input.value = '';
    }
}

async function deleteProfilePhoto() {
    const status = document.getElementById('profilePhotoStatus');
    if (!currentUser || !authToken) return;
    if (!currentUser.profilePhoto) {
        status.textContent = 'Todavía no guardaste una foto de perfil.';
        return;
    }
    if (!confirm('¿Querés eliminar la foto de perfil de tu cuenta?')) return;
    try {
        await apiRequest('/api/profile/photo', { method: 'DELETE' });
        currentUser.profilePhoto = '';
        updateProfilePhotoUI();
        status.textContent = 'Foto de perfil eliminada.';
    } catch (error) {
        status.textContent = error.message || 'No se pudo eliminar la foto.';
    }
}

function switchTab(tabName, selectedButton) {
    // Remover clase active de todos los botones y contenidos
    document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(content => content.classList.remove('active'));
    
    // Activar el tab seleccionado
    if (selectedButton) selectedButton.classList.add('active');
    const selectedTab = document.getElementById(tabName + 'Tab');
    if (selectedTab) selectedTab.classList.add('active');
}

// ==================== FUNCIONES DE EQUIPAMIENTO ====================

function loadEquipment() {
    const equipmentContainer = document.getElementById('characterEquipment');
    equipmentContainer.innerHTML = '';
    
    availableEquipment.forEach(item => {
        const slot = document.createElement('div');
        slot.className = 'equipment-slot';
        
        const isEquipped = gameData.equipment.includes(item.id);
        const isUnlocked = gameData.level >= item.unlockLevel;
        
        if (isEquipped) {
            slot.classList.add('equipped');
        }
        
        slot.innerHTML = `
            <div style="font-size: 20px;">${isUnlocked ? item.icon : '🔒'}</div>
            <div>${isUnlocked ? item.name : 'Bloqueado'}</div>
            <div style="color: #00ff88; font-size: 10px;">${isUnlocked ? item.bonus : `Nivel ${item.unlockLevel}`}</div>
        `;
        
        if (isUnlocked && !isEquipped) {
            slot.onclick = () => equipItem(item.id);
        }
        
        equipmentContainer.appendChild(slot);
    });
}

function equipItem(itemId) {
    if (!gameData.equipment.includes(itemId)) {
        gameData.equipment.push(itemId);
        const item = availableEquipment.find(eq => eq.id === itemId);
        showAchievement(`¡${item.name} equipado! ${item.bonus}`);
        
        applyEquipmentBonuses();
        updateUI();
        loadEquipment();
        saveGameData();
    }
}

function applyEquipmentBonuses() {
    // En una versión real, esto sería más sofisticado
    gameData.equipment.forEach(equipId => {
        const item = availableEquipment.find(eq => eq.id === equipId);
        if (item && item.bonus.includes('Fuerza')) {
            // Aplicar bonus
        }
    });
}

// ==================== ENTRENAMIENTO DE CALISTENIA ====================
const TRAINING_GROUPS = {
    traccion: { label: 'Tracción', description: 'Remo invertido, dominadas y progresiones hacia el muscle-up.', image: 'traccion' },
    empuje: { label: 'Empuje', description: 'Flexiones, fondos y progresiones de fuerza de empuje.', image: 'empuje' },
    piernas: { label: 'Piernas', description: 'Sentadillas, zancadas y variantes unilaterales con peso corporal.', image: 'piernas' },
    core: { label: 'Core y estáticos', description: 'Control del tronco, hollow, planchas y L-sit.', image: 'core' },
    habilidades: { label: 'Habilidades', description: 'Progresiones técnicas de planche, pino y palancas.', image: 'habilidades' },
    acondicionamiento: { label: 'Acondicionamiento', description: 'Movimientos globales con peso corporal.', image: 'piernas' }
};

const PROGRESSION_PATHS = {
    muscleUp: {
        title: 'Ruta de tracción hacia el muscle-up',
        steps: [
            'Remo invertido / dominada australiana: 3 × 8–12',
            'Dominada asistida: 3 × 5–8',
            'Sostén arriba y bajadas negativas: 3 × 3–5 o 5–10 s',
            'Dominada estricta: 3–4 × 4–8',
            'Dominada alta/explosiva hacia el pecho: 3–4 × 3–5',
            'Muscle-up con asistencia y después sin ayuda: 4 × 1–3'
        ]
    },
    pushup: {
        title: 'Ruta de empuje',
        steps: [
            'Flexión contra la pared o inclinada: 3 × 8–12',
            'Flexión con rodillas apoyadas: 3 × 8–12',
            'Flexión de brazos completa: 3 × 6–12',
            'Flexión declinada o con mayor recorrido: 3 × 6–10',
            'Flexión de pica: 3 × 5–8',
            'Flexión de pino con apoyo: 3 × 3–6',
            'Variante unilateral o de planche: solo con técnica sólida'
        ]
    },
    dip: {
        title: 'Ruta de fondos',
        steps: [
            'Fondos asistidos o con apoyo de pies: 3 × 6–10',
            'Fondos en banco/silla estable: 3 × 8–12',
            'Fondos en paralelas: 3 × 5–10',
            'Fondos en anillas: progresión avanzada, con control'
        ]
    },
    legs: {
        title: 'Ruta de piernas',
        steps: [
            'Sentadilla con peso corporal: 3 × 10–15',
            'Zancadas: 3 × 8–12 por pierna',
            'Sentadilla búlgara: 3 × 8–10 por pierna',
            'Pistol squat / shrimp squat asistida: 3 × 4–8 por pierna'
        ]
    },
    core: {
        title: 'Ruta de core y control corporal',
        steps: [
            'Plancha: 3 × 20–40 s',
            'Hollow hold: 3 × 15–30 s',
            'L-sit con pies apoyados o agrupado: 4 × 8–15 s',
            'L-sit completo o en straddle: 4 × 8–15 s',
            'Dragon flag: 3 × 3–6 repeticiones controladas'
        ]
    },
    planche: {
        title: 'Ruta de planche',
        steps: [
            'Apoyo con inclinación hacia delante (planche lean): 4 × 10–20 s',
            'Tuck planche con asistencia: 4 × 5–10 s',
            'Progresiones más extendidas: avanzar solo manteniendo control'
        ]
    },
    lever: {
        title: 'Ruta de palancas',
        steps: [
            'Tuck front lever / agrupado: 4 × 5–10 s',
            'Front lever con mayor extensión: 4 × 5–10 s',
            'Back lever: entrenar como habilidad aparte, con progresión gradual'
        ]
    },
    handstand: {
        title: 'Ruta de pino',
        steps: [
            'Posición de pica y apoyo de manos: 3 × 20–30 s',
            'Pino contra pared: 4 × 10–30 s',
            'Flexiones de pino: empezar con recorrido parcial y apoyo seguro'
        ]
    }
};

function normalizeTrainingText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function translateExerciseName(sourceName) {
    const n = String(sourceName || '').toLowerCase();
    const rules = [
        [/muscle.?up/, 'Muscle-up'],
        [/dominadas australianas|australian pull.?ups?|remo invertido|inverted row|incline row|bodyweight row/, 'Remo invertido (dominada australiana)'],
        [/assisted chin.?ups|dominada asistida/, 'Dominada asistida'],
        [/chin.?up isometric hold/, 'Sostén isométrico de dominada supina'],
        [/pull.?up isometric hold/, 'Sostén isométrico de dominada'],
        [/dominada de arquero|archer pull.?ups?/, 'Dominada de arquero'],
        [/dominadas typewriter|typewriter pull.?ups?/, 'Dominada tipo typewriter'],
        [/dominadas con agarre supino|reverse.?grip pull.?ups?/, 'Dominada con agarre supino'],
        [/dominadas? en agarre neutro|neutral.?grip pull.?ups?/, 'Dominada con agarre neutro'],
        [/dominadas? \(agarre ancho\)|wide.?grip pull.?ups?/, 'Dominada con agarre ancho'],
        [/front lever pull.?up/, 'Dominada en front lever'],
        [/front lever agrupado|tuck front lever/, 'Front lever agrupado'],
        [/front lever/, 'Front lever (palanca frontal)'],
        [/back lever/, 'Back lever (palanca trasera)'],
        [/dominada alta|dominadas altas|explosive pull.?ups?|high pull.?ups?|chest.?to.?bar pull.?ups?/, 'Dominada alta/explosiva'],
        [/dominadas|pull.?ups?/, 'Dominada estricta'],
        [/wall push.?ups?/, 'Flexión contra la pared'],
        [/flexiones?\s*\|\s*inclinadas|incline push.?ups?/, 'Flexión inclinada'],
        [/flexiones? de rodillas|knee push.?ups?/, 'Flexión con rodillas apoyadas'],
        [/deficit push.?ups?/, 'Flexión con mayor recorrido'],
        [/explosive push.?ups?/, 'Flexión explosiva'],
        [/one armed push.?ups?/, 'Flexión a una mano'],
        [/scapular push.?ups?/, 'Flexión escapular'],
        [/hindu push.?ups?/, 'Flexión hindú'],
        [/russian push.?ups?/, 'Flexión rusa'],
        [/tyson push.?ups?/, 'Flexión tipo Tyson'],
        [/box handstand push.?up/, 'Flexión de pino con apoyo'],
        [/handstand push.?ups?/, 'Flexión de pino'],
        [/push.?ups?/, 'Flexión de brazos'],
        [/pike hold/, 'Posición de pica isométrica'],
        [/vpushup|v push.?up/, 'Flexión en V'],
        [/triceps push up/, 'Flexión con énfasis en tríceps'],
        [/flexiones? en pino/, 'Flexión de pino'],
        [/flexión pseudo planche/, 'Flexión pseudo-planche'],
        [/planche lean hold/, 'Inclinación isométrica hacia la planche'],
        [/tuck planche/, 'Planche agrupada'],
        [/planche dinamica/, 'Planche dinámica'],
        [/handstand/, 'Pino (equilibrio de manos)'],
        [/ring dips/, 'Fondos en anillas'],
        [/triceps dips \(assisted\)/, 'Fondos asistidos'],
        [/fondos en paralelas|parallel bar dips/, 'Fondos en paralelas'],
        [/fondos en silla|bench dips/, 'Fondos en banco estable'],
        [/fondos entre bancos/, 'Fondos entre bancos'],
        [/\bdips\b/, 'Fondos'],
        [/bodyweight squat hd/, 'Sentadilla con peso corporal'],
        [/shrimp squat/, 'Sentadilla shrimp a una pierna'],
        [/pistol squat|sentadillas en pistol/, 'Sentadilla pistol'],
        [/supported split squat/, 'Sentadilla dividida con apoyo'],
        [/unilateral lunges|alternate back lunges/, 'Zancadas alternas'],
        [/squat jumps/, 'Sentadilla con salto'],
        [/single leg glute bridge/, 'Puente de glúteo a una pierna'],
        [/glute bridges?/, 'Puente de glúteos'],
        [/leg raises?|hanging knee raises?/, 'Elevaciones de piernas o rodillas'],
        [/sit.?ups?/, 'Abdominales completos'],
        [/superman hold/, 'Superman isométrico'],
        [/hollow hold/, 'Hollow hold (posición de barquito)'],
        [/dragon flag/, 'Dragon flag (bandera)'],
        [/l.?sit \(foot supported\)/, 'L-sit con pies apoyados'],
        [/l.?sit agrupado/, 'L-sit agrupado'],
        [/l.?sit en straddle/, 'L-sit en apertura'],
        [/l.?sit/, 'L-sit'],
        [/reverse plank/, 'Plancha inversa'],
        [/side crunch/, 'Abdominales oblicuos'],
        [/plank jacks/, 'Plancha con apertura de piernas'],
        [/plank-to-elbow extension/, 'Plancha con extensión de codos'],
        [/forearm plank|plancha de antebrazo/, 'Plancha de antebrazos'],
        [/high plank|plancha alta/, 'Plancha alta'],
        [/plank|plancha/, 'Plancha'],
        [/burpees/, 'Burpees'],
        [/jump squats?/, 'Sentadilla con salto'],
        [/bodyweight squat|squats?/, 'Sentadilla con peso corporal'],
        [/lunges|lunge/, 'Zancadas'],
        [/crunch/, 'Abdominales tipo crunch']
    ];
    for (const [pattern, translated] of rules) if (pattern.test(n)) return translated;
    // En las pocas variantes restantes se conserva el nombre de wger si ya está en español.
    return sourceName;
}

function getExerciseTrainingMeta(exercise) {
    const name = String(exercise.apiName || exercise.name || '');
    const equipmentText = (Array.isArray(exercise.equipment) ? exercise.equipment : []).join(' ');
    const n = normalizeTrainingText(name);
    const e = normalizeTrainingText(equipmentText);
    if (!n) return null;
    // El catálogo público también contiene movilidad, estiramientos y aparatos de gimnasio; no son el foco de Calistium.
    if (/(^| )(stretch|stretches|stretching|estiramiento|estiramientos|mobility|movilidad|breathing|respiracion|relaxation|foam roller|warm up|warming up|calentamiento|cool down|enfriamiento|yoga)( |$)/i.test(n)) return null;
    if (/(machine|maquina|multipress|smith|dumbbell|mancuerna|barbell|barra olimpica|kettlebell|cable|treadmill|leg press|hack squat machine|rowing machine|lat pulldown|pulldown|weighted neck|with dumbbells|con mancuernas|con barra|con peso extra)/i.test(n + ' ' + e)) return null;
    if (/^calf raise using hack squat machine$/.test(n) || /rowing machine/.test(n)) return null;

    let group = '';
    let route = '';
    let stage = 1;
    let order = 100;
    const isMuscleUp = /muscle.?up/.test(n);
    const isAustralianRow = /dominadas australianas|remo invertido|inverted row|incline row/.test(n);
    const isAssistedPull = /dominada asistida|assisted chin|assisted pull|chin.?up assisted/.test(n);
    const isIsometricPull = /pull.?up isometric|chin.?up isometric|isometrico de dominada/.test(n);
    const isExplosivePull = /explosive pull.?ups?|high pull.?ups?|chest.?to.?bar pull.?ups?|dominadas altas?|dominada alta/.test(n);
    const isArcherPull = /arquero|archer|typewriter/.test(n);

    if (/front lever|back lever/.test(n)) {
        group = 'habilidades'; route = 'lever';
        stage = /tuck|agrupado/.test(n) ? 1 : /pull.?up/.test(n) ? 3 : /back lever/.test(n) ? 3 : 2;
        order = 500 + stage;
    } else if (/planche|plancha dinamica/.test(n) && !/plancha/.test(n)) {
        group = 'habilidades'; route = 'planche';
        stage = /tuck|agrupada/.test(n) ? 2 : /lean|inclinacion/.test(n) ? 1 : 3;
        order = 600 + stage;
    } else if (/handstand|pino|box handstand/.test(n)) {
        group = 'habilidades'; route = 'handstand';
        stage = /push.?up|flexion/.test(n) ? 3 : 2;
        order = 700 + stage;
    } else if (/muscle.?up/.test(n) || /dominada|pull.?up|chin.?up|inverted row|remo invertido|australian row|l.?sit pull.?up/.test(n)) {
        group = 'traccion';
        if (isMuscleUp) { route = 'muscleUp'; stage = 6; order = 6; }
        else if (isAustralianRow) { route = 'muscleUp'; stage = 1; order = 1; }
        else if (isAssistedPull) { route = 'muscleUp'; stage = 2; order = 2; }
        else if (isIsometricPull) { route = 'muscleUp'; stage = 3; order = 3; }
        else if (isExplosivePull) { route = 'muscleUp'; stage = 5; order = 5; }
        else if (isArcherPull) { route = 'dominadaAvanzada'; stage = 5; order = 20; }
        else if (/front lever|back lever/.test(n)) { route = 'lever'; stage = 2; order = 500; }
        else if (/l.?sit pull/.test(n)) { route = 'dominadaAvanzada'; stage = 5; order = 21; }
        else { route = 'muscleUp'; stage = 4; order = 4; }
    } else if (/push.?up|pushup|flexion|flexiones|fondos|\bdips?\b|pike hold/.test(n)) {
        group = 'empuje';
        if (/fondos|\bdips?\b/.test(n)) {
            route = 'dip';
            stage = /assisted|asistid/.test(n) ? 1 : /silla|banco|bench/.test(n) ? 2 : /parallel|paralelas/.test(n) ? 3 : /ring|anillas/.test(n) ? 4 : 2;
            order = 100 + stage;
        } else {
            route = 'pushup';
            if (/wall push|contra la pared/.test(n)) stage = 1;
            else if (/incline|inclinada/.test(n)) stage = 1;
            else if (/knee|rodillas/.test(n)) stage = 2;
            else if (/pike|pica/.test(n)) stage = 5;
            else if (/handstand|pino/.test(n)) stage = 6;
            else if (/one armed|una mano|planche|pseudo planche/.test(n)) stage = 7;
            else if (/decline|declinada|deficit|mayor recorrido|explosive|explosiva/.test(n)) stage = 4;
            else if (/scapular|escapular/.test(n)) stage = 0;
            else stage = 3;
            order = stage * 10 + (/scapular|escapular/.test(n) ? 0 : 1);
        }
    } else if (/squat|sentadilla|lunge|zancada|shrimp squat|glute bridge|puente de gluteo/.test(n)) {
        group = 'piernas'; route = 'legs';
        if (/pistol|shrimp|una pierna|single leg/.test(n)) stage = 4;
        else if (/bulgarian|bulgara|split squat|sentadilla dividida/.test(n)) stage = 3;
        else if (/lunge|zancada/.test(n)) stage = 2;
        else stage = 1;
        order = stage * 10;
    } else if (/plank|plancha|hollow|crunch|sit.?up|abdominal|dragon flag|l.?sit|leg raise/.test(n)) {
        group = 'core'; route = /crunch|sit.?up|abdominal|leg raise/.test(n) ? 'coreAccessory' : 'core';
        if (/dragon flag/.test(n)) stage = 5;
        else if (/l.?sit/.test(n)) stage = /foot supported|agrupado|tuck/.test(n) ? 3 : /straddle|apertura/.test(n) ? 4 : 4;
        else if (/hollow/.test(n)) stage = 2;
        else if (/plank|plancha/.test(n)) stage = 1;
        else stage = 2;
        order = stage * 10;
    } else if (/burpee/.test(n)) {
        group = 'acondicionamiento'; route = 'conditioning'; stage = 1; order = 10;
    } else {
        return null;
    }

    // Se aceptan únicamente variantes claramente de peso corporal o implementos típicos de calistenia.
    if (/(dumbbell|mancuerna|barbell|kettlebell|cable|machine|maquina|multipress|smith|treadmill|leg press|trx)/i.test(e)) return null;
    let level = stage <= 2 ? 'Inicial' : stage <= 4 ? 'Intermedio' : 'Avanzado';
    if (group === 'habilidades' && stage <= 2) level = 'Técnica';
    const statBoost = group === 'core' || group === 'acondicionamiento' ? 'endurance' : group === 'habilidades' ? 'agility' : 'strength';
    return { group, route, stage, order, level, statBoost, imageGroup: TRAINING_GROUPS[group].image };
}

// El catálogo de wger puede tener varios IDs que terminan con el mismo nombre traducido.
// Conservamos una sola tarjeta y damos prioridad al registro con imagen e información útil.
function deduplicateCalisthenicsExercises(items) {
    const byDisplayName = new Map();
    const qualityScore = (exercise) => {
        const descriptionLength = String(exercise.description || '').trim().length;
        const imageScore = exercise.imageUrl ? 10000 : 0;
        const muscleScore = (Array.isArray(exercise.muscles) ? exercise.muscles.length : 0) * 20;
        const stagePenalty = Number(exercise.trainingMeta && exercise.trainingMeta.stage || 1) * 5;
        return imageScore + Math.min(descriptionLength, 1500) + muscleScore - stagePenalty;
    };
    for (const exercise of items) {
        const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
        if (!meta || !exercise.name) continue;
        const key = `${meta.group}:${normalizeTrainingText(exercise.name)}`;
        const existing = byDisplayName.get(key);
        if (!existing || qualityScore(exercise) > qualityScore(existing)) byDisplayName.set(key, exercise);
    }
    return [...byDisplayName.values()];
}

function getExercisePrescription(exercise) {
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise) || { group: 'empuje', route: 'pushup', stage: 3 };
    const n = normalizeTrainingText(exercise.apiName || exercise.name);
    let sets = 3, reps = '8–12 repeticiones', restSeconds = 90, unit = 'reps';
    if (meta.group === 'traccion') {
        if (meta.route === 'muscleUp' && meta.stage === 1) { sets = 3; reps = '8–12 repeticiones'; restSeconds = 90; }
        else if (meta.route === 'muscleUp' && meta.stage === 2) { sets = 3; reps = '5–8 repeticiones asistidas'; restSeconds = 120; }
        else if (meta.route === 'muscleUp' && meta.stage === 3) { sets = 3; reps = '5–10 s de sostén o 3–5 bajadas'; restSeconds = 120; unit = 'mixed'; }
        else if (/muscle.?up/.test(n)) { sets = 4; reps = '1–3 repeticiones'; restSeconds = 180; }
        else if (meta.route === 'dominadaAvanzada') { sets = 3; reps = '3–6 repeticiones'; restSeconds = 150; }
        else { sets = 4; reps = '4–8 repeticiones'; restSeconds = 120; }
    } else if (meta.group === 'empuje') {
        if (meta.route === 'dip') {
            sets = 3; reps = meta.stage <= 2 ? '8–12 repeticiones' : '5–10 repeticiones'; restSeconds = meta.stage >= 3 ? 120 : 90;
        } else if (meta.route === 'pushup' && meta.stage >= 5) {
            sets = 3; reps = meta.stage >= 6 ? '3–6 repeticiones controladas' : '5–8 repeticiones'; restSeconds = 120;
        } else if (/explosive|explosiva|palmada/.test(n)) {
            sets = 3; reps = '4–6 repeticiones'; restSeconds = 120;
        } else {
            sets = 3; reps = meta.stage <= 2 ? '8–12 repeticiones' : '6–12 repeticiones'; restSeconds = 90;
        }
    } else if (meta.group === 'piernas') {
        if (meta.stage >= 3) { sets = 3; reps = '6–10 por pierna'; restSeconds = 120; }
        else if (/lunge|zancada/.test(n)) { sets = 3; reps = '8–12 por pierna'; restSeconds = 90; }
        else { sets = 3; reps = '10–15 repeticiones'; restSeconds = 90; }
    } else if (meta.group === 'core') {
        if (/dragon flag/.test(n)) { sets = 3; reps = '3–6 repeticiones lentas'; restSeconds = 120; }
        else if (/l.?sit|hollow|plank|plancha/.test(n)) { sets = 3; reps = /l.?sit/.test(n) ? '8–15 s de sostén' : /hollow/.test(n) ? '15–30 s de sostén' : '20–40 s de sostén'; restSeconds = 60; unit = 'seconds'; }
        else { sets = 3; reps = '10–15 repeticiones'; restSeconds = 60; }
    } else if (meta.group === 'habilidades') {
        sets = 4; reps = meta.route === 'handstand' ? '10–30 s de práctica' : meta.route === 'planche' ? '5–15 s de sostén' : '5–10 s de sostén'; restSeconds = 120; unit = 'seconds';
    } else if (meta.group === 'acondicionamiento') {
        sets = 3; reps = '6–10 repeticiones'; restSeconds = 90;
    }
    return { sets, reps, restSeconds, unit };
}

function getExerciseGuide(exercise) {
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise) || { group: 'empuje', route: 'pushup', stage: 3 };
    const n = normalizeTrainingText(exercise.apiName || exercise.name);
    if (meta.group === 'traccion') {
        if (/muscle.?up/.test(n)) return {
            summary: 'Movimiento avanzado de transición desde una dominada hasta quedar por encima de la barra. Requiere fuerza y técnica previas.',
            steps: ['Empezá solo si podés hacer varias dominadas estrictas con técnica limpia.', 'Usá una barra firme y espacio despejado; practicá con banda o asistencia si todavía no dominás la transición.', 'Tirá la barra hacia la parte alta del pecho y llevá el torso por encima con una transición controlada.', 'Terminá en apoyo con los codos extendidos. Bajá con control y detenete si aparece dolor.'],
            safety: 'No lo uses como ejercicio inicial. Priorizá dominadas estrictas y dominadas altas antes de intentar la transición.'
        };
        if (/dominadas australianas|remo invertido|inverted row|incline row/.test(n)) return {
            summary: 'Tirón horizontal con el peso corporal; es una buena base antes de progresar a las dominadas verticales.',
            steps: ['Colocá la barra baja o las anillas a una altura firme y sujetalas con las manos.', 'Mantené cabeza, tronco y piernas alineados; ajustá la dificultad doblando las rodillas si lo necesitás.', 'Llevá el pecho hacia las manos tirando de los codos hacia atrás.', 'Bajá en 2–3 segundos sin dejar caer la cadera ni encoger los hombros.'],
            safety: 'Comprobá que la barra o las anillas estén firmes antes de cada serie.'
        };
        if (/assisted|asistid/.test(n)) return {
            summary: 'Versión asistida de la dominada para practicar el recorrido completo con ayuda.',
            steps: ['Usá una banda resistente bien asegurada o una asistencia estable.', 'Empezá con los hombros activos y el cuerpo quieto.', 'Tirá hasta acercar la barbilla a la barra sin balancearte.', 'Descendé lentamente hasta volver a extender los brazos de forma controlada.'],
            safety: 'La ayuda debe ser estable; no te dejes caer al final de la repetición.'
        };
        if (/isometric|isometrico/.test(n)) return {
            summary: 'Trabajo isométrico para fortalecer una parte del recorrido de la dominada.',
            steps: ['Alcanzá la posición alta con una ayuda o un apoyo seguro.', 'Mantené la barbilla por encima de la barra y los hombros activos.', 'Sostené el tiempo indicado sin patear ni balancear el cuerpo.', 'Bajá con ayuda o controlando la fase negativa.'],
            safety: 'No saltes desde una altura que no puedas bajar de forma segura.'
        };
        return {
            summary: 'Ejercicio de tracción para fortalecer espalda, brazos y control escapular.',
            steps: ['Tomá la barra con un agarre firme y dejá el cuerpo estable.', 'Iniciá el tirón activando los hombros, sin columpiarte.', 'Llevá la barbilla hacia la barra dentro de tu rango controlado.', 'Bajá lentamente hasta casi extender los brazos y repetí.'],
            safety: 'Evitá balanceos fuertes y no fuerces un rango que cause dolor en hombros o codos.'
        };
    }
    if (meta.group === 'empuje') {
        if (meta.route === 'dip') return {
            summary: 'Movimiento de empuje para pecho, tríceps y hombros, con dificultad según el apoyo utilizado.',
            steps: ['Asegurá el banco o las paralelas antes de empezar.', 'Mantené los hombros lejos de las orejas y el abdomen firme.', 'Flexioná los codos y bajá solo hasta un rango cómodo.', 'Empujá el apoyo hasta volver arriba sin rebotar ni bloquear con violencia.'],
            safety: 'Si sentís dolor en la parte anterior del hombro, reducí la profundidad o elegí una variante más fácil.'
        };
        if (/pike|pica|handstand|pino|planche/.test(n)) return {
            summary: 'Variante técnica de empuje que exige control de hombros, muñecas y tronco.',
            steps: ['Prepará una superficie firme y despejá el espacio alrededor.', 'Colocá las manos estables y mantené el abdomen contraído.', 'Descendé de forma lenta, con los codos y hombros bajo control.', 'Empujá de vuelta sin perder la alineación; detené la serie si la técnica se rompe.'],
            safety: 'Las variantes de pino y planche son avanzadas. Empezá con apoyo o recorrido reducido y no entrenes hasta el fallo técnico.'
        };
        return {
            summary: 'Ejercicio de empuje. Elegí una variante que te permita mantener el cuerpo firme y el recorrido completo.',
            steps: ['Apoyá las manos aproximadamente al ancho de los hombros.', 'Alineá cabeza, tronco y cadera; contraé abdomen y glúteos.', 'Bajá el pecho hacia el apoyo sin hundir la cintura.', 'Empujá hasta volver a la posición inicial manteniendo el control.'],
            safety: 'Si no alcanzás el rango con buena técnica, elegí una variante inclinada o con rodillas apoyadas.'
        };
    }
    if (meta.group === 'piernas') {
        if (/lunge|zancada/.test(n)) return {
            summary: 'Trabajo unilateral de piernas para fuerza, equilibrio y control de cadera.',
            steps: ['Parate con el tronco erguido y los pies separados al ancho de caderas.', 'Dá un paso cómodo hacia delante o atrás.', 'Bajá controlando ambas rodillas y mantené el pie delantero apoyado.', 'Volvé a la posición inicial y completá las repeticiones de ambos lados.'],
            safety: 'La rodilla debe seguir la dirección de los dedos del pie; acortá el paso si perdés estabilidad.'
        };
        if (/pistol|shrimp|una pierna|single leg/.test(n)) return {
            summary: 'Variante unilateral avanzada de sentadilla; requiere equilibrio y movilidad además de fuerza.',
            steps: ['Usá una pared, poste o apoyo estable si aún no controlás el movimiento.', 'Bajá despacio sobre una pierna sin dejar que la rodilla colapse hacia dentro.', 'Mantené el pie completo apoyado y el tronco bajo control.', 'Subí empujando el suelo y repetí con la otra pierna.'],
            safety: 'Comenzá asistido. No fuerces la profundidad ni la rodilla para alcanzar una repetición.'
        };
        return {
            summary: 'Base de fuerza de piernas con el peso corporal.',
            steps: ['Separá los pies aproximadamente al ancho de hombros y apoyá toda la planta.', 'Llevá la cadera hacia atrás y doblá las rodillas de forma controlada.', 'Mantené el pecho estable y las rodillas alineadas con los pies.', 'Empujá el suelo para volver arriba sin rebotar.'],
            safety: 'Usá un rango sin dolor y una velocidad que puedas controlar.'
        };
    }
    if (meta.group === 'core') {
        if (/l.?sit/.test(n)) return {
            summary: 'Ejercicio isométrico de core y compresión de cadera; adaptá la palanca a tu nivel.',
            steps: ['Apoyá las manos firmemente en paralelas, bloques o el suelo si la variante lo permite.', 'Empujá el apoyo para alejar los hombros de las orejas.', 'Elevá las rodillas o las piernas según la variante y sostené el tronco estable.', 'Respirá de forma controlada y terminá antes de perder la posición.'],
            safety: 'Empezá con rodillas agrupadas o pies apoyados si no podés mantener la versión completa.'
        };
        if (/hollow/.test(n)) return {
            summary: 'Isometría para aprender a mantener el tronco firme y la zona lumbar controlada.',
            steps: ['Acostate boca arriba y presioná suavemente la zona lumbar contra el suelo.', 'Elevá hombros y piernas solo hasta la altura que puedas controlar.', 'Mantené abdomen firme sin arquear la espalda.', 'Respirá corto y controlado; relajá la posición al terminar.'],
            safety: 'Si la espalda se arquea, doblá las rodillas o acercá los brazos al cuerpo.'
        };
        if (/plank|plancha/.test(n)) return {
            summary: 'Isometría de estabilidad para el tronco, sin dejar que la cadera se hunda o se eleve demasiado.',
            steps: ['Apoyá antebrazos o manos según la variante, con codos bajo los hombros.', 'Extendé las piernas y mantené una línea desde cabeza hasta talones.', 'Contraé abdomen y glúteos y seguí respirando.', 'Mantené la posición durante el tiempo indicado sin perder alineación.'],
            safety: 'Terminá la serie cuando ya no puedas mantener la postura, aunque quede tiempo.'
        };
        if (/dragon flag/.test(n)) return {
            summary: 'Ejercicio avanzado de anti-extensión; requiere gran control del abdomen y la espalda.',
            steps: ['Sujetate a un soporte firme por detrás de la cabeza.', 'Activá el abdomen y elevá el cuerpo manteniendo una línea rígida.', 'Bajá despacio como una unidad, sin doblar la cintura.', 'Usá recorrido parcial o una variante regresiva si no podés controlar la bajada.'],
            safety: 'No lo practiques en un soporte inestable ni si sentís dolor lumbar.'
        };
        return {
            summary: 'Trabajo de abdomen y estabilidad del tronco con el peso corporal.',
            steps: ['Prepará el apoyo con la espalda o la pelvis estable.', 'Activá abdomen sin tirar del cuello.', 'Realizá la repetición de forma lenta y controlada.', 'Volvé al inicio sin usar impulso y mantené la respiración.'],
            safety: 'La calidad del movimiento es más importante que acumular repeticiones.'
        };
    }
    if (meta.group === 'habilidades') {
        if (meta.route === 'planche') return {
            summary: 'Progresión de apoyo e inclinación hacia planche; carga alta sobre muñecas y hombros.',
            steps: ['Apoyá las manos sobre suelo firme y separá los dedos para estabilizar.', 'Mantené los codos extendidos y los hombros activos.', 'Inclinate hacia delante solo unos centímetros, manteniendo abdomen y glúteos firmes.', 'Sostené el tiempo prescrito y retrocedé si perdés la posición.'],
            safety: 'Avanzá en pequeños pasos; no practiques una variante completa si la muñeca o el hombro molestan.'
        };
        if (meta.route === 'handstand') return {
            summary: 'Práctica de equilibrio invertido y control de hombros.',
            steps: ['Usá una pared y despejá completamente el espacio.', 'Apoyá las manos con dedos abiertos y empujá el suelo.', 'Subí con ayuda si hace falta y mantené el abdomen firme.', 'Bajá de manera controlada antes de fatigarte.'],
            safety: 'Practicá junto a una pared libre; no intentes equilibrios libres sin una base segura.'
        };
        return {
            summary: 'Habilidad isométrica avanzada de control del cuerpo; la progresión depende de la palanca.',
            steps: ['Empezá por la posición agrupada o la variante más corta disponible.', 'Mantené hombros activos, codos bajo control y abdomen firme.', 'Sostené pocos segundos sin perder la forma.', 'Aumentá el tiempo o extendé la palanca solo cuando puedas repetir la posición limpiamente.'],
            safety: 'Estas habilidades requieren progresión gradual y apoyo firme; no fuerces articulaciones.'
        };
    }
    return {
        summary: 'Movimiento global con peso corporal para trabajar fuerza y acondicionamiento.',
        steps: ['Prepará espacio despejado y realizá una repetición controlada de práctica.', 'Mantené el tronco estable al cambiar de posición.', 'Usá un ritmo que te permita conservar la técnica durante toda la serie.', 'Descansá antes de que la ejecución se vuelva desordenada.'],
        safety: 'Elegí una variante de bajo impacto si todavía estás aprendiendo el movimiento.'
    };
}

function getProgressionSteps(exercise) {
    const route = (exercise.trainingMeta || getExerciseTrainingMeta(exercise) || {}).route;
    if (route === 'muscleUp') return PROGRESSION_PATHS.muscleUp;
    if (route === 'pushup') return PROGRESSION_PATHS.pushup;
    if (route === 'dip') return PROGRESSION_PATHS.dip;
    if (route === 'legs') return PROGRESSION_PATHS.legs;
    if (route === 'core') return PROGRESSION_PATHS.core;
    if (route === 'planche') return PROGRESSION_PATHS.planche;
    if (route === 'lever') return PROGRESSION_PATHS.lever;
    if (route === 'handstand') return PROGRESSION_PATHS.handstand;
    return null;
}

function getProgressionStageLabel(exercise) {
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
    if (!meta) return '';
    const progression = getProgressionSteps(exercise);
    if (!progression || Number(meta.stage) === 0) return `${meta.level} · ejercicio complementario`;
    const safeStage = Math.min(Math.max(Number(meta.stage || 1), 1), progression.steps.length);
    return `Paso ${safeStage} de ${progression.steps.length}`;
}

function exerciseImageMarkup(exercise, className) {
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise) || { imageGroup: 'empuje' };
    const fallback = `./images/calistenia-${meta.imageGroup || 'empuje'}.svg`;
    const hasRealImage = Boolean(exercise && exercise.imageUrl);
    const src = hasRealImage ? exercise.imageUrl : fallback;
    const label = hasRealImage ? 'Imagen de wger' : 'Ilustración orientativa';
    return `<div class="exercise-art"><img src="${escapeHTML(src)}" data-fallback="${escapeHTML(fallback)}" alt="${escapeHTML(exercise.name || 'Ejercicio de calistenia')}" class="${escapeHTML(className)}" onerror="if(this.dataset.fallback && !this.dataset.failedFallback){this.dataset.failedFallback='1';this.src=this.dataset.fallback;this.nextElementSibling.textContent='Ilustración orientativa';}" loading="lazy"><span class="exercise-art-label">${label}</span></div>`;
}

function getVisibleCalisthenicsExercises() {
    const query = normalizeTrainingText(document.getElementById('exerciseSearch')?.value || '');
    const selectedGroup = document.getElementById('exerciseGroupFilter')?.value || 'todos';
    const selectedLevel = document.getElementById('exerciseLevelFilter')?.value || 'todos';
    return exercises.filter(exercise => {
        const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
        if (!meta) return false;
        if (selectedGroup !== 'todos' && meta.group !== selectedGroup) return false;
        if (selectedLevel !== 'todos' && meta.level !== selectedLevel) return false;
        const haystack = normalizeTrainingText(`${exercise.name} ${exercise.description || ''} ${(exercise.muscles || []).join(' ')}`);
        return !query || haystack.includes(query);
    }).sort((a, b) => {
        const ma = a.trainingMeta || getExerciseTrainingMeta(a);
        const mb = b.trainingMeta || getExerciseTrainingMeta(b);
        return TRAINING_GROUPS[ma.group].label.localeCompare(TRAINING_GROUPS[mb.group].label, 'es') || ma.order - mb.order || a.name.localeCompare(b.name, 'es');
    });
}

function renderCalisthenicsCatalog() {
    const grid = document.getElementById('exercisesGrid');
    if (!grid) return;
    const visible = getVisibleCalisthenicsExercises();
    grid.innerHTML = '';
    if (!visible.length) {
        grid.innerHTML = '<div class="catalog-status"><h3>No encontramos ejercicios con esos filtros</h3><p>Probá otra palabra o seleccioná “Todos los grupos”.</p></div>';
        return;
    }
    const groupOrder = ['traccion', 'empuje', 'piernas', 'core', 'habilidades', 'acondicionamiento'];
    for (const groupKey of groupOrder) {
        const groupExercises = visible.filter(exercise => (exercise.trainingMeta || getExerciseTrainingMeta(exercise)).group === groupKey);
        if (!groupExercises.length) continue;
        const group = TRAINING_GROUPS[groupKey];
        const section = document.createElement('section');
        section.className = 'exercise-group-section';
        section.innerHTML = `<div class="exercise-group-heading"><div><h3>${escapeHTML(group.label)}</h3><p>${escapeHTML(group.description)}</p></div><span>${groupExercises.length} ejercicios</span></div><div class="exercise-group-cards"></div>`;
        const cards = section.querySelector('.exercise-group-cards');
        groupExercises.forEach(exercise => {
            const card = document.createElement('article');
            card.className = 'exercise-card';
            const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
            const guide = getExerciseGuide(exercise);
            const prescription = getExercisePrescription(exercise);
            const isCompleted = gameData.completedExercises.includes(exercise.id);
            if (isCompleted) card.classList.add('completed');
            card.innerHTML = `
                <div class="exercise-image-container">${exerciseImageMarkup(exercise, 'exercise-image')}</div>
                <div class="exercise-card-heading"><h4>${escapeHTML(exercise.name)}</h4><span class="difficulty-badge level-${normalizeTrainingText(meta.level).replace(/\s/g, '-')}">${escapeHTML(meta.level)}</span></div>
                <p class="exercise-summary">${escapeHTML(guide.summary)}</p>
                <div class="exercise-prescription-chip"><strong>${prescription.sets} series</strong> · ${escapeHTML(prescription.reps)} · descanso ${prescription.restSeconds} s</div>
                <div class="exercise-stage-chip">${escapeHTML(getProgressionStageLabel(exercise))}</div>
                ${isCompleted ? '<p class="exercise-completed-label">✓ Registrado anteriormente; podés repetirlo cuando quieras.</p>' : ''}
                <button class="btn exercise-open-button" type="button">Ver técnica y progresión</button>
            `;
            card.querySelector('.exercise-open-button').addEventListener('click', () => openExerciseModal(exercise));
            cards.appendChild(card);
        });
        grid.appendChild(section);
    }
}

async function loadExercises() {
    const grid = document.getElementById('exercisesGrid');
    if (!grid) return;
    if (!exercisesLoaded) {
        grid.innerHTML = '<p class="catalog-status">Conectando con el catálogo de calistenia de wger…</p>';
        try {
            const response = await apiRequest('/api/exercises', { method: 'GET', tokenOverride: '' });
            const incoming = Array.isArray(response.exercises) ? response.exercises : [];
            const mappedExercises = incoming.map(item => {
                const apiName = String(item.name || '').trim();
                const mapped = {
                    ...item,
                    id: Number(item.id),
                    apiName,
                    name: translateExerciseName(apiName),
                    description: String(item.description || '').trim(),
                    imageUrl: String(item.imageUrl || ''),
                    equipment: Array.isArray(item.equipment) ? item.equipment : [],
                    muscles: Array.isArray(item.muscles) ? item.muscles : [],
                    musclesSecondary: Array.isArray(item.musclesSecondary) ? item.musclesSecondary : [],
                    xpReward: 10
                };
                mapped.trainingMeta = getExerciseTrainingMeta(mapped);
                mapped.statBoost = mapped.trainingMeta ? mapped.trainingMeta.statBoost : 'strength';
                return mapped;
            }).filter(item => Number.isInteger(item.id) && item.name && item.trainingMeta);
            exercises = deduplicateCalisthenicsExercises(mappedExercises);
            exercisesLoaded = true;
        } catch (error) {
            grid.innerHTML = `<div class="catalog-error"><p>No se pudo cargar el catálogo de calistenia.</p><p>${escapeHTML(error.message || 'Revisá la conexión a Internet e intentá nuevamente.')}</p><button class="btn" type="button" onclick="loadExercises()">Reintentar</button></div>`;
            return;
        }
    }
    renderCalisthenicsCatalog();
    renderRoutineManager();
}

function openExerciseModal(exercise) {
    const modal = document.getElementById('exerciseModal');
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
    const guide = getExerciseGuide(exercise);
    const prescription = getExercisePrescription(exercise);
    const progression = getProgressionSteps(exercise);
    const category = meta ? TRAINING_GROUPS[meta.group].label : 'Calistenia';
    const sourceUrl = exercise.sourceUrl || 'https://wger.de/';
    const licenseText = exercise.license ? ` · Licencia: ${escapeHTML(exercise.license)}` : '';
    const licenseUrl = exercise.licenseUrl ? ` · <a href="${escapeHTML(exercise.licenseUrl)}" target="_blank" rel="noopener noreferrer">Ver licencia</a>` : '';
    const attribution = exercise.attribution ? ` · Atribución: ${escapeHTML(exercise.attribution)}` : '';
    document.getElementById('modalTitle').textContent = exercise.name;
    document.getElementById('modalContent').innerHTML = `
        <div class="modal-exercise-image-container">${exerciseImageMarkup(exercise, 'modal-exercise-image')}</div>
        <div class="exercise-detail-badges"><span class="difficulty-badge">${escapeHTML(category)}</span><span class="exercise-stage-chip">${escapeHTML(getProgressionStageLabel(exercise))}</span></div>
        <p class="exercise-guide-summary">${escapeHTML(guide.summary)}</p>
        <section class="exercise-prescription"><h4>Tu dosis inicial</h4><div class="exercise-prescription-grid">
            <div><span>Series</span><strong>${prescription.sets}</strong></div>
            <div><span>Repeticiones / tiempo</span><strong>${escapeHTML(prescription.reps)}</strong></div>
            <div><span>Descanso</span><strong>${prescription.restSeconds} segundos</strong></div>
        </div><p>Son valores iniciales orientativos de Calistium, no una prescripción oficial de wger. Ajustá la variante para completar las series con buena técnica.</p></section>
        <h4>Cómo hacerlo</h4><ol class="exercise-guide-steps">${guide.steps.map(step => `<li>${escapeHTML(step)}</li>`).join('')}</ol>
        <div class="exercise-safety-note"><strong>Consejo de seguridad:</strong> ${escapeHTML(guide.safety)}</div>
        ${progression ? `<section class="exercise-progression"><h4>${escapeHTML(progression.title)}</h4><ol>${progression.steps.map((step, index) => `<li class="${index + 1 === meta.stage ? 'current-step' : ''}">${escapeHTML(step)}${index + 1 === meta.stage ? ' <strong>(etapa aproximada de este ejercicio)</strong>' : ''}</li>`).join('')}</ol><p><strong>Cuándo avanzar:</strong> alcanzá el extremo superior del rango en todas las series, con técnica consistente, durante dos entrenamientos antes de probar el siguiente paso.</p></section>` : ''}
        ${exercise.category ? `<p><strong>Categoría original de wger:</strong> ${escapeHTML(exercise.category)}</p>` : ''}
        ${exercise.muscles.length ? `<p><strong>Músculos indicados por wger:</strong> ${exercise.muscles.map(escapeHTML).join(', ')}</p>` : ''}
        <section class="wger-extra"><small>Fuente: <a href="${escapeHTML(sourceUrl)}" target="_blank" rel="noopener noreferrer">wger Workout Manager</a>${licenseText}${licenseUrl}${attribution}</small></section>
        <p class="exercise-completion-note">Podés añadirlo a una rutina guardada y repetir esa rutina cuando quieras.</p>
        <button class="btn" type="button" onclick="addExerciseToRoutine(${Number(exercise.id)})">＋ Agregar a mi rutina</button>
        <p class="catalog-note">El nombre, la fuente y las imágenes disponibles proceden de wger. La guía en español, el orden de progresión y la dosis inicial son orientaciones de Calistium.</p>
    `;
    const doneButton = document.querySelector('#exerciseModal .exercise-complete-button');
    if (doneButton) doneButton.textContent = activeRoutineSession && activeRoutineSession.items.some(item => Number(item.exerciseId) === Number(exercise.id)) ? 'Registrar ejercicio de esta rutina' : 'Registrar ejercicio completado';
    modal.style.display = 'flex';
    modal.dataset.exerciseId = String(exercise.id);
}

function openExerciseById(exerciseId) {
    const exercise = exercises.find(ex => Number(ex.id) === Number(exerciseId));
    if (!exercise) {
        showAchievement('Este movimiento ya no está en el catálogo actual de wger. Actualizá las rutinas o elegí otro ejercicio.');
        return;
    }
    openExerciseModal(exercise);
}

function closeModal() {
    document.getElementById('exerciseModal').style.display = 'none';
}

let activeRoutineSession = null;

function addExerciseToRoutine(exerciseId) {
    const exercise = exercises.find(ex => Number(ex.id) === Number(exerciseId));
    if (!exercise) return;
    if (!Array.isArray(gameData.routineDraft)) gameData.routineDraft = [];
    if (gameData.routineDraft.some(item => Number(item.exerciseId) === Number(exercise.id))) {
        showAchievement('Ese ejercicio ya está en el borrador de la rutina.');
        closeModal();
        return;
    }
    const prescription = getExercisePrescription(exercise);
    const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
    gameData.routineDraft.push({
        exerciseId: exercise.id,
        name: exercise.name,
        group: meta.group,
        groupLabel: TRAINING_GROUPS[meta.group].label,
        sets: prescription.sets,
        reps: prescription.reps,
        restSeconds: prescription.restSeconds,
        stageLabel: getProgressionStageLabel(exercise)
    });
    saveGameData();
    renderRoutineManager();
    showAchievement(`${exercise.name} agregado al borrador de rutina.`);
    closeModal();
}

const BEGINNER_ROUTINE_TEMPLATES = {
    empuje: {
        name: 'Principiante · Empuje',
        targets: [
            /flexion contra la pared|flexion inclinada|flexion con rodillas apoyadas/,
            /flexion de brazos|flexion escapular/,
            /fondos asistidos|fondos en banco|fondos en silla/,
            /flexion escapular|flexion con enfasis en triceps/
        ],
        minimumRest: 90
    },
    traccion: {
        name: 'Principiante · Tirón',
        targets: [
            /remo invertido|dominada australiana/,
            /dominada asistida/,
            /sosten isometrico de dominada/,
            /dominada estricta/
        ],
        minimumRest: 90
    },
    piernas: {
        name: 'Principiante · Piernas',
        targets: [
            /sentadilla con peso corporal/,
            /zancadas alternas|zancadas/,
            /puente de gluteos/,
            /sentadilla dividida con apoyo/
        ],
        minimumRest: 75
    }
};

async function createBeginnerRoutine(groupKey) {
    const template = BEGINNER_ROUTINE_TEMPLATES[groupKey];
    if (!template) return;
    if (!exercisesLoaded) await loadExercises();
    if (!exercisesLoaded || !exercises.length) {
        showAchievement('No se pudo cargar el catálogo de wger. Volvé a intentarlo cuando haya conexión.');
        return;
    }
    if (!Array.isArray(gameData.savedRoutines)) gameData.savedRoutines = [];
    const existing = gameData.savedRoutines.find(item => item.templateKey === groupKey);
    if (existing) {
        showAchievement(`“${existing.name}” ya está guardada. Podés repetirla desde Mis rutinas.`);
        document.getElementById('savedRoutinesList')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        return;
    }

    const candidates = exercises.filter(exercise => {
        const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
        return meta && meta.group === groupKey && Number(meta.stage) <= 3;
    }).sort((a, b) => {
        const ma = a.trainingMeta || getExerciseTrainingMeta(a);
        const mb = b.trainingMeta || getExerciseTrainingMeta(b);
        return ma.stage - mb.stage || Number(Boolean(b.imageUrl)) - Number(Boolean(a.imageUrl)) || a.name.localeCompare(b.name, 'es');
    });
    const selected = [];
    const selectedIds = new Set();
    const selectedNames = new Set();
    for (const target of template.targets) {
        const found = candidates.find(exercise => {
            const key = normalizeTrainingText(exercise.name);
            return target.test(normalizeTrainingText(`${exercise.name} ${exercise.apiName || ''}`)) && !selectedIds.has(exercise.id) && !selectedNames.has(key);
        });
        if (found) {
            selected.push(found);
            selectedIds.add(found.id);
            selectedNames.add(normalizeTrainingText(found.name));
        }
        if (selected.length >= 4) break;
    }
    for (const exercise of candidates) {
        if (selected.length >= 3) break;
        const key = normalizeTrainingText(exercise.name);
        if (selectedIds.has(exercise.id) || selectedNames.has(key)) continue;
        selected.push(exercise);
        selectedIds.add(exercise.id);
        selectedNames.add(key);
    }
    if (selected.length < 2) {
        showAchievement('wger no devolvió suficientes ejercicios adecuados para esta rutina. Probá actualizar el catálogo.');
        return;
    }

    const items = selected.map(exercise => {
        const prescription = getExercisePrescription(exercise);
        const meta = exercise.trainingMeta || getExerciseTrainingMeta(exercise);
        return {
            exerciseId: exercise.id,
            name: exercise.name,
            group: meta.group,
            groupLabel: TRAINING_GROUPS[meta.group].label,
            sets: 3,
            reps: prescription.reps,
            restSeconds: Math.max(template.minimumRest, prescription.restSeconds || 0),
            stageLabel: getProgressionStageLabel(exercise)
        };
    });
    const routine = {
        id: `rutina-inicial-${groupKey}-${Date.now()}`,
        templateKey: groupKey,
        name: template.name,
        items,
        createdAt: new Date().toISOString()
    };
    gameData.savedRoutines.push(routine);
    saveGameData();
    renderRoutineManager();
    showAchievement(`${template.name} guardada con ${items.length} ejercicios. Podés repetirla cuando quieras.`);
    document.getElementById('savedRoutinesList')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function removeDraftExercise(index) {
    if (!Array.isArray(gameData.routineDraft)) return;
    gameData.routineDraft.splice(Number(index), 1);
    saveGameData();
    renderRoutineManager();
}

function clearRoutineDraft() {
    if (!gameData.routineDraft || !gameData.routineDraft.length) return;
    if (!confirm('¿Querés vaciar el borrador de la rutina?')) return;
    gameData.routineDraft = [];
    saveGameData();
    renderRoutineManager();
}

function saveCurrentRoutine() {
    const draft = Array.isArray(gameData.routineDraft) ? gameData.routineDraft : [];
    const name = String(document.getElementById('routineNameInput')?.value || '').trim();
    if (!draft.length) {
        alert('Primero abrí ejercicios y tocá “Agregar a mi rutina” para armar tu rutina.');
        return;
    }
    if (!name) {
        alert('Poné un nombre para guardar la rutina.');
        document.getElementById('routineNameInput')?.focus();
        return;
    }
    if (!Array.isArray(gameData.savedRoutines)) gameData.savedRoutines = [];
    gameData.savedRoutines.push({
        id: `rutina-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        name: name.slice(0, 60),
        items: draft.map(item => ({ ...item })),
        createdAt: new Date().toISOString()
    });
    gameData.routineDraft = [];
    if (document.getElementById('routineNameInput')) document.getElementById('routineNameInput').value = '';
    saveGameData();
    renderRoutineManager();
    showAchievement('Rutina guardada. Podés iniciarla y repetirla todas las veces que quieras.');
}

function deleteSavedRoutine(routineId) {
    const routine = (gameData.savedRoutines || []).find(item => String(item.id) === String(routineId));
    if (!routine || !confirm(`¿Eliminar la rutina “${routine.name}”?`)) return;
    gameData.savedRoutines = gameData.savedRoutines.filter(item => String(item.id) !== String(routineId));
    if (activeRoutineSession && String(activeRoutineSession.routineId) === String(routineId)) activeRoutineSession = null;
    saveGameData();
    renderRoutineManager();
}

function startSavedRoutine(routineId) {
    const routine = (gameData.savedRoutines || []).find(item => String(item.id) === String(routineId));
    if (!routine || !Array.isArray(routine.items) || !routine.items.length) {
        showAchievement('Esta rutina está vacía. Editala o guardá otra con ejercicios del catálogo.');
        return;
    }
    activeRoutineSession = {
        routineId: routine.id,
        routineName: routine.name,
        startedAt: new Date().toISOString(),
        items: routine.items.map(item => ({ ...item })),
        completedExerciseIds: []
    };
    renderRoutineManager();
    document.getElementById('activeRoutinePanel')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    showAchievement(`Rutina “${routine.name}” iniciada. Podés repetirla cuando quieras.`);
}

function finishActiveRoutine() {
    if (!activeRoutineSession) return;
    const done = activeRoutineSession.completedExerciseIds.length;
    if (!done) {
        if (!confirm('Todavía no registraste ningún ejercicio. ¿Querés cerrar esta sesión sin guardarla como completada?')) return;
        activeRoutineSession = null;
        renderRoutineManager();
        return;
    }
    if (!Array.isArray(gameData.workoutHistory)) gameData.workoutHistory = [];
    gameData.workoutHistory.unshift({
        routineId: activeRoutineSession.routineId,
        routineName: activeRoutineSession.routineName,
        completedAt: new Date().toISOString(),
        completedExercises: done,
        plannedExercises: activeRoutineSession.items.length
    });
    gameData.workoutHistory = gameData.workoutHistory.slice(0, 50);
    gameData.totalWorkouts = Number(gameData.totalWorkouts || 0) + 1;
    gameData.xp += 10;
    while (gameData.xp >= gameData.maxXP) levelUp();
    const finishedName = activeRoutineSession.routineName;
    activeRoutineSession = null;
    updateUI();
    checkForNewAchievements();
    saveGameData();
    renderRoutineManager();
    showAchievement(`¡Sesión “${finishedName}” registrada! +10 XP.`);
}

function renderRoutineManager() {
    const draftList = document.getElementById('routineDraftList');
    const savedList = document.getElementById('savedRoutinesList');
    const activePanel = document.getElementById('activeRoutinePanel');
    if (!draftList || !savedList || !activePanel) return;
    const draft = Array.isArray(gameData.routineDraft) ? gameData.routineDraft : [];
    draftList.innerHTML = draft.length ? draft.map((item, index) => `
        <div class="routine-item"><div><strong>${escapeHTML(item.name)}</strong><small>${escapeHTML(item.groupLabel || item.group || 'Calistenia')} · ${Number(item.sets) || 3} series × ${escapeHTML(item.reps || '8–12')} · descanso ${Number(item.restSeconds) || 90} s</small></div><button type="button" class="btn btn-secondary routine-remove" onclick="removeDraftExercise(${index})" aria-label="Quitar ${escapeHTML(item.name)}">Quitar</button></div>
    `).join('') : '<p class="routine-empty">Todavía no agregaste ejercicios. Abrí el catálogo y elegí “Agregar a mi rutina”.</p>';
    const routines = Array.isArray(gameData.savedRoutines) ? gameData.savedRoutines : [];
    savedList.innerHTML = routines.length ? routines.map(routine => `
        <article class="saved-routine-card"><div class="saved-routine-info"><h4>${escapeHTML(routine.name)}</h4><p>${Array.isArray(routine.items) ? routine.items.length : 0} ejercicios · reutilizable cuando quieras</p></div><div class="saved-routine-actions"><button type="button" class="btn" onclick="startSavedRoutine('${escapeHTML(routine.id)}')">Repetir rutina</button><button type="button" class="btn btn-secondary" onclick="deleteSavedRoutine('${escapeHTML(routine.id)}')">Eliminar</button></div></article>
    `).join('') : '<p class="routine-empty">Todavía no guardaste ninguna rutina. Armá una con tus ejercicios favoritos.</p>';
    if (!activeRoutineSession) {
        activePanel.style.display = 'none';
        activePanel.innerHTML = '';
    } else {
        activePanel.style.display = 'block';
        activePanel.innerHTML = `<div class="active-routine-heading"><div><h3>Sesión activa: ${escapeHTML(activeRoutineSession.routineName)}</h3><p>Marcá cada ejercicio desde su ficha cuando termines todas las series.</p></div><span>${activeRoutineSession.completedExerciseIds.length}/${activeRoutineSession.items.length}</span></div>
            <div class="active-routine-items">${activeRoutineSession.items.map(item => {
                const done = activeRoutineSession.completedExerciseIds.includes(Number(item.exerciseId));
                return `<div class="routine-item ${done ? 'routine-item-done' : ''}"><div><strong>${escapeHTML(item.name)}</strong><small>${Number(item.sets) || 3} series × ${escapeHTML(item.reps || '8–12')} · descanso ${Number(item.restSeconds) || 90} s</small></div><button type="button" class="btn btn-secondary routine-remove" onclick="openExerciseById(${Number(item.exerciseId)})">${done ? 'Ver ejercicio' : 'Abrir ejercicio'}</button></div>`;
            }).join('')}</div><button type="button" class="btn" onclick="finishActiveRoutine()">Finalizar y guardar sesión</button>`;
    }
    const history = Array.isArray(gameData.workoutHistory) ? gameData.workoutHistory.slice(0, 4) : [];
    const historyContainer = document.getElementById('workoutHistoryList');
    if (historyContainer) historyContainer.innerHTML = history.length ? history.map(item => `<div class="workout-history-item"><strong>${escapeHTML(item.routineName || 'Entrenamiento')}</strong><span>${Number(item.completedExercises) || 0}/${Number(item.plannedExercises) || 0} ejercicios · ${new Date(item.completedAt).toLocaleDateString('es-AR')}</span></div>`).join('') : '<p class="routine-empty">Tus sesiones finalizadas aparecerán acá.</p>';
}

function completeExercise() {
    const exerciseId = Number(document.getElementById('exerciseModal').dataset.exerciseId);
    const exercise = exercises.find(ex => Number(ex.id) === exerciseId);
    if (!exercise) {
        showAchievement('No se encontró este ejercicio en el catálogo actual de wger. Actualizá el catálogo e intentá nuevamente.');
        closeModal();
        return;
    }

    // Registrar un ejercicio es repetible: completedExercises queda como lista de hitos únicos,
    // mientras cada finalización suma XP y puede participar en una sesión de rutina.
    if (!Array.isArray(gameData.completedExercises)) gameData.completedExercises = [];
    if (!gameData.completedExercises.includes(exerciseId)) gameData.completedExercises.push(exerciseId);
    gameData.xp += exercise.xpReward || 10;
    gameData[exercise.statBoost || 'strength'] = Math.min(1000, Number(gameData[exercise.statBoost || 'strength'] || 0) + 1);

    const belongsToActiveRoutine = Boolean(activeRoutineSession && activeRoutineSession.items.some(item => Number(item.exerciseId) === exerciseId));
    if (belongsToActiveRoutine) {
        if (!activeRoutineSession.completedExerciseIds.includes(exerciseId)) activeRoutineSession.completedExerciseIds.push(exerciseId);
    } else {
        gameData.totalWorkouts = Number(gameData.totalWorkouts || 0) + 1;
    }
    while (gameData.xp >= gameData.maxXP) levelUp();
    showAchievement(`¡${exercise.name} registrado! +${exercise.xpReward || 10} XP. Podés repetirlo cuando quieras.`);
    updateUI();
    renderCalisthenicsCatalog();
    renderRoutineManager();
    loadEquipment();
    checkForNewAchievements();
    saveGameData();
    closeModal();
}


function levelUp() {
    gameData.level++;
    gameData.xp -= gameData.maxXP;
    gameData.maxXP = Math.floor(gameData.maxXP * 1.2);
    gameData.strength++;
    gameData.endurance++;
    
    showAchievement(`🎉 ¡NIVEL ${gameData.level}! 🎉 +1 Fuerza +1 Resistencia`);
}

// ==================== FUNCIONES DE DESARROLLO PERSONAL ====================

function loadDevelopmentContent() {
    const container = document.getElementById('developmentContent') || createDevelopmentContainer();
    const currentLesson = developmentLessons[gameData.currentLessonIndex];
    
    container.innerHTML = `
        <div class="lesson-header">
            <h2>${currentLesson.title}</h2>
            <div class="lesson-progress">
                <span>Lección ${gameData.currentLessonIndex + 1} de ${developmentLessons.length}</span>
                <div class="progress-bar">
                    <div class="progress-fill" style="width: ${((gameData.currentLessonIndex + 1) / developmentLessons.length) * 100}%"></div>
                </div>
            </div>
        </div>
        
        <div class="lesson-content">
            ${currentLesson.content}
        </div>
        
        <div class="lesson-navigation">
            ${gameData.currentLessonIndex > 0 ? 
                `<button onclick="previousLesson()" class="nav-btn prev-btn">← Lección Anterior</button>` : 
                '<div></div>'
            }
            
            ${gameData.currentLessonIndex < developmentLessons.length - 1 ? 
                `<button onclick="nextLesson()" class="nav-btn next-btn">Siguiente Lección →</button>` : 
                `<button onclick="completeCourse()" class="nav-btn complete-btn">🏆 Completar Curso</button>`
            }
        </div>
    `;
}

function createDevelopmentContainer() {
    const tabContent = document.getElementById('developmentTab');
    const container = document.createElement('div');
    container.id = 'developmentContent';
    container.className = 'development-container';
    tabContent.appendChild(container);
    return container;
}

function nextLesson() {
    if (gameData.currentLessonIndex < developmentLessons.length - 1) {
        gameData.currentLessonIndex++;
        loadDevelopmentContent();
        saveGameData();
        
        gameData.xp += 10;
        gameData.mentality++;
        showAchievement('🧠 +10 XP y +1 Mentalidad por completar lección');
        updateUI();
    }
}

function previousLesson() {
    if (gameData.currentLessonIndex > 0) {
        gameData.currentLessonIndex--;
        loadDevelopmentContent();
        saveGameData();
    }
}

function completeCourse() {
    if (!gameData.courseCompleted) {
        gameData.courseCompleted = true;
        gameData.xp += 100;
        gameData.mentality += 10;
        showAchievement('🏆 ¡CURSO COMPLETO! +100 XP y +10 Mentalidad. ¡Eres un maestro mental!');
        updateUI();
        saveGameData();
    } else {
        showAchievement('Ya completaste el curso. ¡Puedes revisar las lecciones cuando quieras!');
    }
}

// ==================== FUNCIONES DE LOGROS ====================

function getAchievementDefinitions() {
    return [
        { id: 'first_workout', icon: '🏁', name: 'Primera sesión', description: 'Completá tu primer entrenamiento.', condition: () => Number(gameData.totalWorkouts || 0) >= 1, text: '🏆 ¡Primera sesión completada!' },
        { id: 'week_warrior', icon: '🔥', name: 'Guerrero de la semana', description: 'Registrá 7 entrenamientos.', condition: () => Number(gameData.totalWorkouts || 0) >= 7, text: '🔥 ¡Guerrero de la semana! 7 entrenamientos' },
        { id: 'muscle_master', icon: '💪', name: 'Maestro del Muscle-up', description: 'Registrá un muscle-up del catálogo.', condition: () => gameData.completedExercises.some(id => exercises.some(ex => Number(ex.id) === Number(id) && /muscle.?up/i.test(ex.name))), text: '💪 ¡Maestro del Muscle-up!' },
        { id: 'equipment_collector', icon: '🎒', name: 'Coleccionista de equipamiento', description: 'Desbloqueá al menos 3 recompensas de equipamiento.', condition: () => gameData.equipment.length >= 3, text: '🎒 ¡Coleccionista de equipamiento!' }
    ];
}

function renderAchievementsPanel() {
    const grid = document.getElementById('achievementsGrid');
    const counter = document.getElementById('achievementsCounter');
    if (!grid || !counter) return;
    if (!Array.isArray(gameData.achievementsUnlocked)) gameData.achievementsUnlocked = [];
    const definitions = getAchievementDefinitions();
    const unlocked = new Set(gameData.achievementsUnlocked);
    const count = definitions.filter(item => unlocked.has(item.id)).length;
    counter.textContent = `${count}/${definitions.length}`;
    grid.innerHTML = definitions.map(item => {
        const isUnlocked = unlocked.has(item.id);
        return `<article class="achievement-card ${isUnlocked ? 'is-unlocked' : 'is-locked'}"><span class="achievement-icon" aria-hidden="true">${isUnlocked ? item.icon : '🔒'}</span><div><strong>${escapeHTML(item.name)}</strong><p>${escapeHTML(item.description)}</p><span class="achievement-state">${isUnlocked ? 'Desbloqueado' : 'Bloqueado'}</span></div></article>`;
    }).join('');
}

function checkForNewAchievements() {
    if (!Array.isArray(gameData.achievementsUnlocked)) gameData.achievementsUnlocked = [];
    getAchievementDefinitions().forEach(achievement => {
        if (achievement.condition() && !gameData.achievementsUnlocked.includes(achievement.id)) {
            gameData.achievementsUnlocked.push(achievement.id);
            setTimeout(() => showAchievement(achievement.text), 1000);
        }
    });
    renderAchievementsPanel();
}
function showAchievement(text) {
    const achievement = document.getElementById('achievement');
    achievement.textContent = text;
    achievement.style.display = 'block';
    setTimeout(() => {
        achievement.style.display = 'none';
    }, 4000);
}

// ==================== EVENT LISTENERS ====================

document.getElementById('loginForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const email = document.getElementById('loginEmail').value;
    const password = document.getElementById('loginPassword').value;
    const button = this.querySelector('button[type="submit"]');
    if (button) { button.disabled = true; button.textContent = 'Ingresando…'; }
    try {
        await login(email, password);
        showApp();
    } catch (error) {
        alert(error.message || 'No se pudo iniciar sesión. Verificá tus datos.');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Iniciar Sesión'; }
    }
});

document.getElementById('registerForm').addEventListener('submit', async function(e) {
    e.preventDefault();
    const name = document.getElementById('registerName').value.trim();
    const email = document.getElementById('registerEmail').value.trim();
    const password = document.getElementById('registerPassword').value;
    const button = this.querySelector('button[type="submit"]');
    if (name.length < 2) { alert('El nombre debe tener al menos 2 caracteres.'); return; }
    if (password.length < 6) { alert('La contraseña debe tener al menos 6 caracteres.'); return; }
    if (button) { button.disabled = true; button.textContent = 'Creando cuenta…'; }
    try {
        await register(name, email, password);
        showApp();
    } catch (error) {
        alert(error.message || 'No se pudo crear la cuenta. Verificá que el servidor esté funcionando.');
    } finally {
        if (button) { button.disabled = false; button.textContent = 'Crear Cuenta'; }
    }
});

// Cerrar modal al hacer click fuera
window.onclick = function(event) {
    const modal = document.getElementById('exerciseModal');
    if (event.target === modal) {
        closeModal();
    }
}

// Auto-guardar cada 60 segundos
setInterval(saveGameData, 60000);

// Guardar al cerrar la página
window.addEventListener('beforeunload', saveGameData);

// Restaurar exclusivamente una sesión válida del servidor. Las cuentas locales de prueba ya se eliminaron.
window.addEventListener('DOMContentLoaded', async function() {
    window.initializeGoogleSignIn();
    if (!authToken) return;
    try {
        const user = await apiRequest('/api/user');
        applyUserSession(user, authToken);
        showApp();
    } catch (error) {
        if (error.isNetworkError) {
            console.warn('No se pudo validar la sesión con el servidor. Iniciá Calistium mediante npm start.');
            return;
        }
        if (error.status === 401 || error.status === 403 || error.status === 404) {
            authToken = '';
            localStorage.removeItem('calistium_token');
            localStorage.removeItem('calistium_user_id');
        }
    }
});
