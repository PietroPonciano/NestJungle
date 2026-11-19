/**
 * Provisionamento do login de runtime da aplicação (privilégio mínimo).
 *
 * Executado pelo CLI de migration, com o usuário de migração (dono do schema).
 * Cria ou atualiza um login membro de `wagering_app` (permissões definidas na
 * Migration002). Idempotente: rodar N vezes só reaplica senha e atributos.
 *
 * O login nunca é superusuário nem dono de objetos; assim a aplicação não
 * consegue desligar triggers, apagar lançamentos ou alterar transações
 * terminais, nem que um bug ou injeção tente.
 */
import type { MikroORM } from '@mikro-orm/postgresql';
import { APP_ROLE } from '../../../migrations/Migration20261119000002AppRoleAndTerminalGuard';

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export async function provisionAppLogin(
  orm: MikroORM,
  migrationUser: string,
  appUser: string,
  appPassword: string,
): Promise<void> {
  if (!IDENTIFIER.test(appUser)) {
    throw new Error('DATABASE_APP_USER inválido (use [a-z_][a-z0-9_]*)');
  }
  if (appUser === migrationUser || appUser === APP_ROLE) {
    throw new Error(
      'DATABASE_APP_USER deve ser diferente do usuário de migração e do role de grupo',
    );
  }
  if (appPassword === '') throw new Error('DATABASE_APP_PASSWORD obrigatório');

  const em = orm.em.fork();
  const exists = await em.execute<{ n: string }[]>(
    'SELECT COUNT(*)::text AS n FROM pg_roles WHERE rolname = ?',
    [appUser],
  );
  const verb = exists[0]?.n === '1' ? 'ALTER' : 'CREATE';
  // CREATE/ALTER ROLE não aceitam bind parameters: format(%I, %L) faz o
  // quoting no próprio PostgreSQL.
  const [statement] = await em.execute<{ sql: string }[]>(
    `SELECT format('${verb} ROLE %I LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD %L', ?::text, ?::text) AS sql`,
    [appUser, appPassword],
  );
  if (statement === undefined) throw new Error('falha ao montar o comando de role');
  await em.execute(statement.sql);
  await em.execute(`GRANT ${APP_ROLE} TO "${appUser}"`);
}
