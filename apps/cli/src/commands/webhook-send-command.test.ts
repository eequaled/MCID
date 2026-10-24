import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// getStoredSigningSecret decrypts with the OS keychain via defaultKeyProvider;
// in tests the stored entry is plaintext and decrypt simply returns it, so no
// real keychain is ever touched.
vi.mock('../crypto-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../crypto-store.js')>();
  return {
    ...actual,
    defaultKeyProvider: () => ({
      keyForWrite: async () => ({ source: 'keychain' as const, key: Buffer.alloc(32) }),
      keyFor: async () => Buffer.alloc(32),
    }),
    decrypt: vi.fn(async (ciphertext: string) => ciphertext),
  };
});

import { cleanupCliTest, json, runCli } from '../test-support/cli-harness.js';
import { baseRoutes, inboundWebhook, WEBHOOK_ID } from '../test-support/fixtures.js';
import { setWebhookSecret, updateConfig, type Config } from '../config.js';

afterEach(cleanupCliTest);

async function configWithStoredSecret(tmp: string): Promise<string> {
  const path = join(tmp, 'config.json');
  vi.stubEnv('MCID_CLI_CONFIG_PATH', path);
  await updateConfig(path, (config: Config) =>
    setWebhookSecret(
      { ...config, activeProfile: 'default', profiles: { default: { baseUrl: 'http://localhost:3000', session: null } } },
      'default',
      WEBHOOK_ID,
      { secret: 'whsec_test_secret', name: inboundWebhook.name, slug: inboundWebhook.slug },
    ),
  );
  return path;
}

const steppedSchema = {
  steps: [
    {
      id: 'contact',
      title: 'Contact',
      fields: [
        { name: 'message', type: 'string', required: true },
        {
          name: 'topic',
          type: 'enum',
          required: true,
          options: [
            { value: 'support', label: 'Support' },
            { value: 'sales', label: 'Sales' },
          ],
        },
      ],
    },
  ],
};

function sendRoutes() {
  return baseRoutes({
    [`GET /admin/inbound-webhooks/${WEBHOOK_ID}`]: () =>
      json({
        ...inboundWebhook,
        schema: steppedSchema,
        requireSignature: true,
        acceptedOrigins: ['https://portal.example.com'],
      }),
  });
}

describe('webhook send --print-curl', () => {
  it('masks the API key unless --reveal is passed', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-send-'));
    await configWithStoredSecret(tmp);

    const masked = await runCli(
      ['webhook', 'send', 'contact-form', '--example', '--print-curl', '--api-key', 'mcid_live_supersecretkey123'],
      { routes: sendRoutes() },
    );
    expect(masked.exitCode).toBe(0);
    expect(masked.stdout).not.toContain('mcid_live_supersecretkey123');
    expect(masked.stdout).toContain('<MCID_API_KEY>');

    const revealed = await runCli(
      ['webhook', 'send', 'contact-form', '--example', '--print-curl', '--reveal', '--api-key', 'mcid_live_supersecretkey123'],
      { routes: sendRoutes() },
    );
    expect(revealed.exitCode).toBe(0);
    expect(revealed.stdout).toContain('mcid_live_supersecretkey123');
  });
});

describe('webhook send --example', () => {
  it('builds the payload from steps[].fields with enum option values', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-send-'));
    await configWithStoredSecret(tmp);

    const result = await runCli(
      ['webhook', 'send', 'contact-form', '--example', '--print-curl'],
      { routes: sendRoutes() },
    );

    expect(result.exitCode).toBe(0);
    // -d '<json>' body: fields from the step, enum emitted as its value string
    const payloadMatch = result.stdout.match(/-d '(.*)'/);
    expect(payloadMatch).not.toBeNull();
    const payload = JSON.parse(payloadMatch![1] as string) as Record<string, unknown>;
    expect(payload['message']).toBeTypeOf('string');
    expect(payload['topic']).toBe('support');
    // never the {value,label} object the API rejects
    expect(payload['topic']).not.toMatch(/value/);
  });
});

describe('webhook send --data schema validation', () => {
  it('rejects a payload missing required fields before sending anything', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'mcid-send-'));
    await configWithStoredSecret(tmp);
    const dataFile = join(tmp, 'payload.json');
    await writeFile(dataFile, JSON.stringify({ message: 'hi' }), 'utf8');

    const result = await runCli(
      ['webhook', 'send', 'contact-form', '--data', dataFile, '--api-key', 'mcid_live_key'],
      { routes: sendRoutes() },
    );

    expect(result.exitCode).not.toBe(0);
    // no request to the ingest endpoint was made
    expect(
      result.requests.some((r) => r.path === `/inbound-webhooks/${WEBHOOK_ID}/submit`),
    ).toBe(false);
  });
});
