/**
 * Uso:
 *   bun run db:migrate    -> aplica todas as migrations pendentes
 *   bun run db:rollback   -> desfaz a última migration
 */
import { MikroORM } from '@mikro-orm/postgresql';
import { buildOrmConfig } from '../mikro-orm.config';

const direction = process.argv[2] ?? 'up';
if (direction !== 'up' && direction !== 'down') {
  console.error(`Direção inválida: "${direction}" (use "up" ou "down")`);
  process.exit(1);
}

const orm = await MikroORM.init(buildOrmConfig());
try {
  const result = direction === 'up' ? await orm.migrator.up() : await orm.migrator.down();
  if (result.length === 0) {
    console.log(`Nada a fazer (${direction}).`);
  } else {
    for (const m of result) console.log(`${direction === 'up' ? '↑' : '↓'} ${m.name}`);
  }
} finally {
  await orm.close(true);
}
