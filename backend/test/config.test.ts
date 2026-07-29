/**
 * The production guard (src/config.ts). It only ever runs on a real deployment,
 * which is exactly why it is tested here: a guard that quietly stopped firing
 * would be discovered by whoever forged a session cookie, not by us.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { assertProductionConfig, config } from '../src/config';

const safe = {
  authSecret: 'a-real-random-secret',
  baseUrl: 'https://finto.example.com',
  databaseUrl: 'postgres://finto:s3cret@db:5432/finto',
  documentEncryptionKey: 'a-real-random-document-key',
};

const before = { ...config };

function inProduction(overrides: Partial<typeof safe>, run: () => void) {
  const prevEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  Object.assign(config, safe, overrides);
  try {
    run();
  } finally {
    process.env.NODE_ENV = prevEnv;
  }
}

afterEach(() => {
  Object.assign(config, before);
});

describe('assertProductionConfig', () => {
  it('passes on a properly configured production server', () => {
    inProduction({}, () => expect(() => assertProductionConfig()).not.toThrow());
  });

  it('refuses the development signing key', () => {
    inProduction({ authSecret: 'finto-dev-secret-change-me' }, () =>
      expect(() => assertProductionConfig()).toThrow(/BETTER_AUTH_SECRET/),
    );
  });

  it('refuses plain http on a public address', () => {
    inProduction({ baseUrl: 'http://finto.example.com' }, () =>
      expect(() => assertProductionConfig()).toThrow(/without https/),
    );
  });

  it('allows plain http on localhost (TLS terminates in front)', () => {
    inProduction({ baseUrl: 'http://localhost:4000' }, () =>
      expect(() => assertProductionConfig()).not.toThrow(),
    );
  });

  it('refuses the development document key', () => {
    inProduction({ documentEncryptionKey: 'finto-dev-document-key-change-me' }, () =>
      expect(() => assertProductionConfig()).toThrow(/DOCUMENT_ENCRYPTION_KEY/),
    );
  });

  it('refuses the docker-compose default database password', () => {
    inProduction({ databaseUrl: 'postgres://finto:finto@postgres:5432/finto' }, () =>
      expect(() => assertProductionConfig()).toThrow(/POSTGRES_PASSWORD/),
    );
  });

  it('reports every problem at once, not one per restart', () => {
    inProduction(
      {
        authSecret: 'finto-dev-secret-change-me',
        baseUrl: 'http://finto.example.com',
        databaseUrl: 'postgres://finto:finto@postgres:5432/finto',
        documentEncryptionKey: 'finto-dev-document-key-change-me',
      },
      () => {
        const message = (() => {
          try {
            assertProductionConfig();
            return '';
          } catch (e) {
            return (e as Error).message;
          }
        })();
        expect(message).toMatch(/BETTER_AUTH_SECRET/);
        expect(message).toMatch(/without https/);
        expect(message).toMatch(/POSTGRES_PASSWORD/);
        expect(message).toMatch(/DOCUMENT_ENCRYPTION_KEY/);
      },
    );
  });

  it('stays inert outside production, so dev and tests keep their defaults', () => {
    Object.assign(config, {
      authSecret: 'finto-dev-secret-change-me',
      baseUrl: 'http://localhost:4000',
      databaseUrl: 'postgres://finto:finto@localhost:5432/finto',
      documentEncryptionKey: 'finto-dev-document-key-change-me',
    });
    expect(() => assertProductionConfig()).not.toThrow();
  });
});
