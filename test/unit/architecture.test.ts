import { describe, expect, test } from 'bun:test';
import { Glob } from 'bun';

// Guardas estáticas de arquitetura (sem infraestrutura): leem o código-fonte.
const root = new URL('../../', import.meta.url).pathname;

async function sources(pattern: string): Promise<{ path: string; text: string }[]> {
  const files: { path: string; text: string }[] = [];
  for await (const path of new Glob(pattern).scan({ cwd: root })) {
    files.push({ path, text: await Bun.file(`${root}${path}`).text() });
  }
  return files;
}

describe('Arquitetura', () => {
  test('domínio puro: nenhum import de NestJS, MikroORM, AWS SDK ou pg', async () => {
    const offenders = (await sources('src/domain/**/*.ts')).filter(({ text }) =>
      /from ['"](@nestjs|@mikro-orm|@aws-sdk|pg)[/'"]/.test(text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  test('Restrição #1: nenhuma conversão de dinheiro para number (parseFloat, toNumber, Number(amount))', async () => {
    const offenders = (await sources('src/**/*.ts')).filter(({ text }) =>
      /parseFloat\(|\.toNumber\(\)|Number\([^)]*(amount|balance|money)/i.test(text),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });

  test('todo arquivo de domínio começa com bloco de invariantes/documentação', async () => {
    const offenders = (await sources('src/domain/**/*.ts')).filter(
      ({ text }) => !text.trimStart().startsWith('/**'),
    );
    expect(offenders.map((f) => f.path)).toEqual([]);
  });
});
