/**
 * Configuração do MikroORM (PostgreSQL).
 *
 * - Entidades via EntitySchema (sem decorators: o Bun não emite metadata e o
 *   domínio fica puro).
 * - Migrations listadas explicitamente (migrationsList): funcionam no bundle
 *   de produção, sem depender de varrer diretórios em runtime.
 * - allowGlobalContext desligado: todo acesso usa um EntityManager fork por
 *   unidade de trabalho, nunca estado compartilhado entre requisições.
 */
import { Migrator } from '@mikro-orm/migrations';
import { MikroORM, defineConfig, type Options } from '@mikro-orm/postgresql';
import { Migration20261117000001InitialSchema } from '../../../migrations/Migration20261117000001InitialSchema';
import type { AppConfig } from '../config/app-config';
import { ALL_SCHEMAS } from './records';

export function buildOrmOptions(db: AppConfig['database']): Options {
  return defineConfig({
    host: db.host,
    port: db.port,
    dbName: db.name,
    user: db.user,
    password: db.password,
    entities: ALL_SCHEMAS,
    extensions: [Migrator],
    allowGlobalContext: false,
    pool: { min: 1, max: db.poolMax },
    debug: false,
    migrations: {
      tableName: 'mikro_orm_migrations',
      transactional: true,
      allOrNothing: true,
      // Sem snapshot: o schema vem só da migration (SQL verbatim), nunca do diff do ORM.
      snapshot: false,
      migrationsList: [
        {
          name: 'Migration20261117000001InitialSchema',
          class: Migration20261117000001InitialSchema,
        },
      ],
    },
  });
}

export function createOrm(db: AppConfig['database']): Promise<MikroORM> {
  return MikroORM.init(buildOrmOptions(db));
}
