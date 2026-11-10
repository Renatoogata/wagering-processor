import { defineConfig } from '@mikro-orm/postgresql';
import { Migrator } from '@mikro-orm/migrations';
import { Migration20261110000000_initial_schema } from './src/infrastructure/persistence/migrations/Migration20261110000000_initial_schema';

/**
 * Lista explícita de migrations (em vez de glob em disco): funciona igual no Bun,
 * em testes e em build, sem depender de carregamento dinâmico de arquivos .ts.
 */
export const migrationsList = [
  { name: 'Migration20261110000000_initial_schema', class: Migration20261110000000_initial_schema },
];

export function buildOrmConfig(databaseUrl = process.env.DATABASE_URL) {
  if (!databaseUrl) throw new Error('DATABASE_URL is not set');

  return defineConfig({
    clientUrl: databaseUrl,
    // entidades (EntitySchema) entram nos próximos passos
    entities: [],
    discovery: { warnWhenNoEntities: false },
    extensions: [Migrator],
    migrations: {
      migrationsList,
      transactional: true, // cada migration roda dentro de uma transação
      allOrNothing: true, // um lote de migrations é aplicado inteiro ou nada
    },
    pool: { min: 2, max: 20 },
    debug: false,
  });
}

export default buildOrmConfig();
