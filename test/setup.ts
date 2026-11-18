import { setDefaultTimeout } from 'bun:test';

// Integração/concorrência com PostgreSQL e LocalStack reais: 60 s por teste.
setDefaultTimeout(60_000);
