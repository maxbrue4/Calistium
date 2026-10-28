#!/usr/bin/env node
// Descarga el catálogo público de wger y lo guarda localmente para no consultar la API en cada visita.
const { fetchWgerCatalog, writeDiskCache, CACHE_FILE } = require('../services/wger-catalog');

async function main() {
  console.log('Consultando el catálogo público de wger (esto puede tardar un poco)…');
  const catalog = await fetchWgerCatalog();
  writeDiskCache(catalog);
  console.log(`Catálogo guardado: ${CACHE_FILE}`);
  console.log(`Ejercicios importados desde wger: ${catalog.count}`);
  console.log('No se usó la lista manual anterior; los nombres y descripciones proceden de la API.');
}

main().catch(error => {
  console.error(`No se pudo importar el catálogo de wger: ${error.message}`);
  process.exitCode = 1;
});
