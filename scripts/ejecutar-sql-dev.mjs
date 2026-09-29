import { execSync } from 'child_process';
import { resolve } from 'path';
import { createReadStream } from 'fs';

const dotenv = await import('dotenv');
dotenv.config();

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('ERROR: DATABASE_URL no definida en .env');
  process.exit(1);
}

// Guardia: la URL debe contener database=tourniquet_dev
const initialCatalogMatch = databaseUrl.match(/Initial Catalog=([^;]+)/i) || databaseUrl.match(/database=([^;]+)/i);
if (!initialCatalogMatch) {
  console.error('ERROR: DATABASE_URL no tiene Initial Catalog/database. Abortando.');
  process.exit(1);
}

const initialCatalog = initialCatalogMatch[1].trim();
if (initialCatalog !== 'tourniquet_dev') {
  console.error(`ERROR: DATABASE_URL apunta a "${initialCatalog}", no a "tourniquet_dev". Abortando para proteger bases ajenas.`);
  process.exit(1);
}

const sqlFile = process.argv[2];
if (!sqlFile) {
  console.error('Uso: node scripts/ejecutar-sql-dev.mjs <archivo.sql>');
  process.exit(1);
}

const sqlPath = resolve(sqlFile);

try {
  // Ejecutar el script SQL con sqlcmd sobre la base de la URL
  const dbName = initialCatalog;
  const cmd = `sqlcmd -i "${sqlPath}" -d "${dbName}" -b -w-1 -h-1`;
  execSync(cmd, { stdio: 'pipe' });
  console.log(`\nScript aplicado exitosamente a la base ${dbName}`);
} catch (error) {
  console.error('Error aplicando el script SQL:', error.message);
  process.exit(1);
}