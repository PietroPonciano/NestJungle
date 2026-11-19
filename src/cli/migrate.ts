/**
 * CLI de migrations: `bun src/cli/migrate.ts up|down|status`.
 * Usado pelo serviço `migrate` do docker compose antes de a app subir.
 */
import { loadConfig } from '../infrastructure/config/app-config';
import { provisionAppLogin } from '../infrastructure/persistence/app-role';
import { createOrm } from '../infrastructure/persistence/mikro-orm.config';

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const config = loadConfig();
  const orm = await createOrm(config.database);
  try {
    if (command === 'up') {
      const applied = await orm.migrator.up();
      console.log(
        JSON.stringify({ msg: 'migrations aplicadas', applied: applied.map((m) => m.name) }),
      );
      // Login de runtime com privilégio mínimo (Migration002). Opcional: sem as
      // variáveis, nada é provisionado e a app usa DATABASE_USER.
      const appUser = process.env.DATABASE_APP_USER;
      const appPassword = process.env.DATABASE_APP_PASSWORD;
      if (appUser !== undefined && appUser !== '') {
        await provisionAppLogin(orm, config.database.user, appUser, appPassword ?? '');
        console.log(JSON.stringify({ msg: 'login da aplicação provisionado', user: appUser }));
      }
    } else if (command === 'down') {
      const reverted = await orm.migrator.down();
      console.log(
        JSON.stringify({ msg: 'migration revertida', reverted: reverted.map((m) => m.name) }),
      );
    } else if (command === 'status') {
      const executed = await orm.migrator.getExecuted();
      const pending = await orm.migrator.getPending();
      console.log(
        JSON.stringify({
          executed: executed.map((m) => m.name),
          pending: pending.map((m) => m.name),
        }),
      );
    } else {
      throw new Error(`Comando desconhecido: ${command} (use up, down ou status)`);
    }
  } finally {
    await orm.close(true);
  }
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ msg: 'falha na migration', error: String(error) }));
  process.exit(1);
});
