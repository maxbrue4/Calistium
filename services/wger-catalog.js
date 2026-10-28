const fs = require('fs');
const path = require('path');

const WGER_BASE = 'https://wger.de/api/v2/';
const CACHE_FILE = path.join(__dirname, '..', 'public', 'data', 'wger-catalog.json');
const CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
let memoryCatalog = null;
let memoryLoadedAt = 0;
let inFlight = null;

function stripHtml(value) {
  return String(value || '')
    .replace(/<br\s*\/?\s*>/gi, '\n')
    .replace(/<\/(p|li|div|h[1-6])\s*>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function absoluteWgerUrl(value) {
  if (!value) return '';
  try { return new URL(value, 'https://wger.de').toString(); } catch (_) { return ''; }
}

function languageText(translation) {
  const language = translation && translation.language;
  if (language && typeof language === 'object') {
    return [language.short_name, language.full_name, language.name, language.id].filter(Boolean).join(' ').toLowerCase();
  }
  return String(language || '').toLowerCase();
}

function chooseTranslation(translations) {
  if (!Array.isArray(translations) || !translations.length) return null;
  const languageId = item => String(item && item.language && typeof item.language === 'object' ? item.language.id || '' : item && item.language || '');
  const spanish = translations.find(item => /(^|\W)(es|spa|spanish|espanol|español)(\W|$)/i.test(languageText(item)))
    || translations.find(item => languageId(item) === '4');
  const english = translations.find(item => /(^|\W)(en|eng|english|ingles|inglés)(\W|$)/i.test(languageText(item)))
    || translations.find(item => languageId(item) === '2');
  return spanish || english || translations.find(item => item && item.name) || translations[0];
}

function relationName(value, lookup) {
  if (value && typeof value === 'object') return String(value.name || value.translation || value.alias || '');
  if (Number.isInteger(Number(value))) return String(lookup.get(Number(value)) || '');
  return String(value || '');
}

function imageUrlFor(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  const image = images.find(value => value && value.is_main && (value.image || value.url))
    || images.find(value => value && (value.image || value.url));
  return absoluteWgerUrl(image && (image.image || image.url));
}

function imageLicense(item) {
  const images = Array.isArray(item.images) ? item.images : [];
  const image = images.find(value => value && value.is_main) || images[0] || {};
  const license = image.license;
  return {
    license: String(image.license_title || (license && (license.full_name || license.short_name || license.name)) || ''),
    licenseUrl: absoluteWgerUrl(image.license_url || image.license_object_url || (license && license.url)),
    attribution: String(image.license_author || image.author || '')
  };
}

function isBodyweightExercise(name, description, equipmentNames, hasEquipmentData = false) {
  const titleAndDescription = `${name} ${description}`.toLowerCase();
  const unwantedEquipment = /\b(dumbbell|barbell|kettlebell|cable|machine|smith machine|treadmill|leg press|pec deck|lat pulldown|weight stack|ez.?bar|weighted plate)\b/i;
  if (equipmentNames.some(item => unwantedEquipment.test(item))) return false;
  if (!hasEquipmentData && !equipmentNames.length) return true;
  if (hasEquipmentData && !equipmentNames.length) {
    return /\b(push.?up|pull.?up|chin.?up|dip|plank|handstand|muscle.?up|burpee|lunge|squat|sit.?up|crunch|calisthenic|bodyweight|flexion|dominada|sentadilla|plancha|zancada|fondos|pino|abdominales)\b/i.test(titleAndDescription);
  }
  const bodyweightEquipment = /\b(none|no equipment|bodyweight|body weight|gym mat|mat|floor|pull.?up bar|chin.?up bar|dip bar|parallel bars|rings?|dip station|wall|box|bench|chair|step|exercise ball)\b/i;
  if (equipmentNames.every(item => bodyweightEquipment.test(item))) return true;
  // When wger does not identify a movement's equipment, only retain clearly recognisable bodyweight terms.
  return /\b(push.?up|pull.?up|chin.?up|dip|plank|handstand|muscle.?up|burpee|lunge|squat|sit.?up|crunch|calisthenic|bodyweight|flexion|dominada|sentadilla|plancha|zancada|fondos|burpee|pino|abdominales)\b/i.test(titleAndDescription);
}

async function fetchAll(endpointName) {
  let url = new URL(endpointName, WGER_BASE).toString();
  const results = [];
  let pageCount = 0;
  while (url) {
    if (++pageCount > 1000) throw new Error('La API de wger devolvió una paginación inesperada.');
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.hostname !== 'wger.de') throw new Error('La API devolvió una URL de paginación no confiable.');
    let response;
    let lastError;
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        response = await fetch(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(25000) });
        if (response.ok) break;
        if (![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`wger respondió HTTP ${response.status}.`);
        lastError = new Error(`wger respondió HTTP ${response.status}.`);
      } catch (error) {
        lastError = error;
      }
      if (attempt < 3) await new Promise(resolve => setTimeout(resolve, 800 * (attempt + 1)));
    }
    if (!response || !response.ok) throw lastError || new Error('No se pudo consultar wger.');
    const data = await response.json();
    if (!Array.isArray(data.results)) throw new Error('wger devolvió un formato de datos inesperado.');
    results.push(...data.results);
    url = data.next ? new URL(data.next, WGER_BASE).toString() : '';
  }
  return results;
}

async function fetchWgerCatalog() {
  const [infos, equipment, categories, muscles] = await Promise.all([
    fetchAll('exerciseinfo/?limit=100'),
    fetchAll('equipment/?limit=100').catch(() => []),
    fetchAll('exercisecategory/?limit=100').catch(() => []),
    fetchAll('muscle/?limit=100').catch(() => [])
  ]);
  const equipmentLookup = new Map(equipment.map(item => [Number(item.id), String(item.name || '')]));
  const categoryLookup = new Map(categories.map(item => [Number(item.id), String(item.name || '')]));
  const muscleLookup = new Map(muscles.map(item => [Number(item.id), String(item.name || '')]));
  const catalog = [];
  const seen = new Set();

  for (const item of infos) {
    const translation = chooseTranslation(item.translations);
    const name = String((translation && translation.name) || '').trim();
    if (!item.id || !name || seen.has(Number(item.id))) continue;
    const description = stripHtml(translation && translation.description);
    const equipmentValues = Array.isArray(item.equipment) ? item.equipment : [];
    const equipmentNames = equipmentValues.map(value => relationName(value, equipmentLookup)).filter(Boolean);
    if (!isBodyweightExercise(name, description, equipmentNames, equipmentValues.length > 0)) continue;

    const category = relationName(item.category, categoryLookup);
    const exerciseMuscles = (Array.isArray(item.muscles) ? item.muscles : []).map(value => relationName(value, muscleLookup)).filter(Boolean);
    const musclesSecondary = (Array.isArray(item.muscles_secondary) ? item.muscles_secondary : []).map(value => relationName(value, muscleLookup)).filter(Boolean);
    const imageUrl = imageUrlFor(item);
    const licenseDetails = imageLicense(item);
    seen.add(Number(item.id));
    catalog.push({
      id: Number(item.id),
      name,
      description,
      category,
      equipment: equipmentNames,
      muscles: exerciseMuscles,
      musclesSecondary,
      imageUrl,
      sourceUrl: `https://wger.de/api/v2/exerciseinfo/${Number(item.id)}/`,
      ...licenseDetails
    });
  }

  catalog.sort((a, b) => a.name.localeCompare(b.name, 'es', { sensitivity: 'base' }));
  if (!catalog.length) throw new Error('wger respondió, pero no se encontraron ejercicios de peso corporal que cumplan el filtro de Calistium.');
  return {
    generatedAt: new Date().toISOString(),
    source: 'https://wger.de/api/v2/exerciseinfo/',
    filter: 'Ejercicios sin equipamiento o con equipamiento compatible con peso corporal; nombres, descripciones e imágenes provienen de wger.',
    count: catalog.length,
    exercises: catalog
  };
}

function readDiskCache() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (parsed && Array.isArray(parsed.exercises) && parsed.exercises.length) return parsed;
  } catch (_) { /* No hay caché local todavía. */ }
  return null;
}

function writeDiskCache(catalog) {
  fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
  fs.writeFileSync(CACHE_FILE, JSON.stringify(catalog, null, 2), 'utf8');
}

async function getWgerCatalog(options = {}) {
  const forceRefresh = Boolean(options.forceRefresh);
  const now = Date.now();
  if (!forceRefresh && memoryCatalog && now - memoryLoadedAt < CACHE_MAX_AGE_MS) return memoryCatalog;

  const diskCache = readDiskCache();
  if (!forceRefresh && diskCache) {
    const age = now - new Date(diskCache.generatedAt || 0).getTime();
    if (Number.isFinite(age) && age >= 0 && age < CACHE_MAX_AGE_MS) {
      memoryCatalog = diskCache;
      memoryLoadedAt = now;
      return diskCache;
    }
  }
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const fresh = await fetchWgerCatalog();
      writeDiskCache(fresh);
      memoryCatalog = fresh;
      memoryLoadedAt = Date.now();
      return fresh;
    } catch (error) {
      const stale = diskCache || readDiskCache();
      if (stale && Array.isArray(stale.exercises) && stale.exercises.length) {
        memoryCatalog = stale;
        memoryLoadedAt = Date.now();
        return { ...stale, staleCache: true, warning: 'No se pudo actualizar wger; se está usando el catálogo guardado.' };
      }
      throw error;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

module.exports = { getWgerCatalog, fetchWgerCatalog, writeDiskCache, CACHE_FILE };
