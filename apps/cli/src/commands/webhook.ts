import { createHmac } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Command } from 'commander';
import { configPath, loadConfig, resolveProfileName } from '../config.js';
import { defaultKeyProvider, decrypt, webhookSecretContext } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import { unwrapArray } from '../lib/api-normalize.js';
import { ApiClient } from '../lib/client.js';
import {
  formatAge,
  printJson,
  printKeyValue,
  printSuccess,
  printTable,
  toCsv,
} from '../lib/output.js';
import { resolveWebhook } from '../lib/resolver.js';
import { parseSince } from '../lib/time.js';
import { buildExamplePayload, validatePayloadAgainstSchema } from '../lib/example-payload.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';
import {
  defaultWebhookDeps,
  webhookCreate,
  webhookDelete,
  webhookGet,
  webhookList,
  webhookRolesSet,
  webhookRotateSecret,
  webhookSecretGet,
  webhookUpdate,
  type WebhookCreateOptions,
  type WebhookDeleteOptions,
  type WebhookGetOptions,
  type WebhookListOptions,
  type WebhookRolesSetOptions,
  type WebhookRotateSecretOptions,
  type WebhookSecretGetOptions,
  type WebhookUpdateOptions,
} from '../webhook-flow.js';

export function registerWebhookCommand(program: Command): void {
  const webhook = program.command('webhook').description('Manage MCID Inbound Webhooks');

  // Existing commands
  webhook
    .command('create <schema-path>')
    .description('Create a webhook on MCID from a schema file and store its signing secret')
    .requiredOption('--name <name>', 'webhook display name')
    .option('--project <project>', 'owning MCID project id or name (omit to pick interactively)')
    .requiredOption(
      '--roles <roleIds>',
      'comma-separated Discord role ids allowed to read submissions',
    )
    .option('--accept-origin <origin>', 'accepted origin (repeatable)', collect, [])
    .option('--slug <slug>', 'URL-safe id, unique in the project (default: derived from --name)')
    .option('--reveal', 'print the signing secret in plain text')
    .requiredOption('--profile <name>', 'profile to create on')
    .action(async (schemaPath: string, options: WebhookCreateOptions) => {
      try {
        await webhookCreate(schemaPath, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook create', err);
      }
    });

  webhook
    .command('update <id>')
    .description('Update an existing webhook')
    .option('--schema <path>', 'replacement schema file')
    .option('--name <name>', 'new display name')
    .option('--active', 'mark the webhook active')
    .option('--inactive', 'mark the webhook inactive')
    .requiredOption('--profile <name>', 'profile to update on')
    .action(async (idOrSlug: string, options: WebhookUpdateOptions) => {
      try {
        const id = await resolveWebhookId(options.profile, idOrSlug);
        await webhookUpdate(id, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook update', err);
      }
    });

  webhook
    .command('list')
    .alias('ls')
    .description('List webhooks')
    .option('--project <projectId>', 'filter by project id')
    .option('--profile <name>', 'profile to use')
    .action(async (options: WebhookListOptions) => {
      try {
        await webhookList(options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook list', err);
      }
    });

  webhook
    .command('get <id>')
    .description('Inspect one webhook')
    .option('--schema-only', 'print only the schema')
    .option('--json', 'emit machine-readable JSON')
    .option('--profile <name>', 'profile to use')
    .action(async (idOrSlug: string, options: WebhookGetOptions) => {
      try {
        const id = await resolveWebhookId(options.profile, idOrSlug);
        await webhookGet(id, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook get', err);
      }
    });

  webhook
    .command('delete <id>')
    .alias('rm')
    .description('Delete a webhook and all its submissions')
    .option('--yes', 'skip the confirmation prompt')
    .requiredOption('--profile <name>', 'profile to delete on')
    .action(async (idOrSlug: string, options: WebhookDeleteOptions) => {
      try {
        const id = await resolveWebhookId(options.profile, idOrSlug);
        await webhookDelete(id, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook delete', err);
      }
    });

  const roles = webhook.command('roles').description('Manage allowed reader roles');
  roles
    .command('set <id>')
    .description('Replace the allowed-reader role list')
    .requiredOption('--roles <roleIds>', 'comma-separated Discord role ids')
    .requiredOption('--profile <name>', 'profile to update on')
    .action(async (idOrSlug: string, options: WebhookRolesSetOptions) => {
      try {
        const id = await resolveWebhookId(options.profile, idOrSlug);
        await webhookRolesSet(id, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook roles set', err);
      }
    });

  webhook
    .command('rotate-secret <id>')
    .description("Rotate a webhook's signing secret")
    .option('--reveal', 'print the secret in plain text')
    .option('--yes', 'skip the confirmation prompt')
    .requiredOption('--profile <name>', 'profile to rotate on')
    .action(async (idOrSlug: string, options: WebhookRotateSecretOptions) => {
      try {
        const id = await resolveWebhookId(options.profile, idOrSlug);
        await webhookRotateSecret(id, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook rotate-secret', err);
      }
    });

  const secret = webhook.command('secret').description('Read a locally stored signing secret');
  secret
    .command('get [webhook]')
    .description(
      'Retrieve a stored signing secret by webhook id or slug (prompts if omitted and more than one is stored)',
    )
    .option('--reveal', 'print the secret in plain text')
    .option('--profile <name>', 'profile to read from')
    .action(async (webhookArg: string | undefined, options: WebhookSecretGetOptions) => {
      try {
        await webhookSecretGet(webhookArg, options, defaultWebhookDeps());
      } catch (err) {
        exitWithError('webhook secret get', err);
      }
    });

  // ── Issue #233 Extensions: send, submissions, submission, watch, docs, settings, readable ──

  // webhook send <webhook> --data <file|-> [--example] [--print-curl]
  webhook
    .command('send <webhook>')
    .description('Sign and submit test payload to an Inbound Webhook')
    .option('--data <file>', 'Payload JSON file or "-" for stdin')
    .option('--example', 'Generate a valid sample payload from the webhook schema')
    .option('--print-curl', 'Print equivalent signed curl command without sending')
    .option('--reveal', 'With --print-curl: print the real API key instead of a placeholder')
    .option('--api-key <key>', 'project API key for the ingest endpoint (or MCID_API_KEY)')
    .option('--origin <origin>', "Origin header (defaults to the webhook's first accepted origin)")
    .option('--profile <name>', 'Profile to use')
    .action(
      async (
        webhookArg: string,
        options: {
          data?: string;
          example?: boolean;
          printCurl?: boolean;
          reveal?: boolean;
          apiKey?: string;
          origin?: string;
          profile?: string;
        },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveWebhook(client, webhookArg);
          const webhookDetail = await client.get<{
            id: string;
            schema: Record<string, unknown>;
            requireSignature?: boolean;
            acceptedOrigins?: string[];
          }>(`/admin/inbound-webhooks/${resolved.id}`);

          // Retrieve stored signing secret
          const cfg = await loadConfig(configPath());
          const profile = resolveProfileName(cfg, options.profile);
          const storedSecret = await getStoredSigningSecret(cfg, profile, resolved.id);

          let rawPayload = '';
          if (options.example) {
            rawPayload = JSON.stringify(buildExamplePayload(webhookDetail.schema), null, 2);
          } else if (options.data === '-') {
            rawPayload = await readStdin();
          } else if (options.data) {
            rawPayload = await readFile(options.data, 'utf8');
          } else {
            throw new CliError(
              'Payload is required: pass --data <file|-> or --example',
              ExitCode.Usage,
            );
          }

          let payload: unknown;
          try {
            payload = JSON.parse(rawPayload);
          } catch {
            throw new CliError('Payload is not valid JSON', ExitCode.PrecheckFailed);
          }
          // Fail before signing and sending when the payload cannot satisfy
          // the schema; the server stays authoritative, this is early feedback.
          const schemaProblems = validatePayloadAgainstSchema(payload, webhookDetail.schema);
          if (schemaProblems.length > 0) {
            throw new CliError(
              `Payload does not match the webhook schema:\n  ${schemaProblems.join('\n  ')}`,
              ExitCode.PrecheckFailed,
            );
          }

          // Sign payload
          const timestamp = Math.floor(Date.now() / 1000);
          const sigHex = createHmac('sha256', storedSecret)
            .update(`${timestamp}.${rawPayload}`, 'utf8')
            .digest('hex');
          const signatureHeader = `t=${timestamp},v1=${sigHex}`;
          const submitUrl = `${client.origin}/api/inbound-webhooks/${resolved.id}/submit`;
          const apiKey = options.apiKey ?? process.env.MCID_API_KEY;
          const origin = options.origin ?? webhookDetail.acceptedOrigins?.[0];

          if (options.printCurl) {
            // The printed command must not leak the API key unless --reveal.
            const printedKey = options.reveal && apiKey ? apiKey : '<MCID_API_KEY>';
            process.stdout.write(
              `curl -X POST "${submitUrl}" \\\n` +
                `  -H "Content-Type: application/json" \\\n` +
                `  -H "Authorization: Bearer ${printedKey}" \\\n` +
                (origin ? `  -H "Origin: ${origin}" \\\n` : '') +
                '  -H "X-MCID-Signature: t=<UNIX_TIMESTAMP>,v1=<HMAC_SHA256>" \\\n' +
                `  -d '${rawPayload.replace(/'/g, "'\\''")}'\n`,
            );
            process.stdout.write(
              `${colors.dim('# Generate a fresh HMAC over <timestamp>.<exact raw body> with the locally stored secret; signatures expire after five minutes and can only be used once.')}\n`,
            );
            return;
          }

          if (!apiKey) {
            throw new CliError(
              'A project API key is required to submit: pass --api-key <key> or set MCID_API_KEY',
              ExitCode.Usage,
            );
          }

          // Send submission
          const res = await fetch(submitUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              ...(origin ? { Origin: origin } : {}),
              'X-MCID-Signature': signatureHeader,
            },
            body: rawPayload,
          });

          const status = res.status;
          let responseBody: unknown;
          try {
            responseBody = await res.json();
          } catch {
            responseBody = await res.text();
          }

          if (res.ok) {
            printSuccess(`Submission accepted (HTTP ${status})`);
            printJson(responseBody);
          } else {
            process.stderr.write(`${colors.red(`✗ Submission rejected (HTTP ${status})`)}\n`);
            printJson(responseBody);
            process.exitCode = ExitCode.Rejected;
          }
        } catch (err) {
          exitWithError('webhook send', err);
        }
      },
    );

  // webhook submissions [list] <webhook> — real nested subcommands, so
  // `webhook submissions export X` exports instead of "list webhook named export".
  const submissionsCmd = webhook
    .command('submissions')
    .description('Submissions received by an inbound webhook');
  const submissionsListOptions = (cmd: Command) =>
    cmd
      .option('--since <date>', 'Filter submissions since (ISO timestamp or 30m, 24h, 7d)')
      .option('--until <date>', 'Filter submissions until (ISO timestamp or 30m, 24h, 7d)')
      .option('--limit <n>', 'Maximum submissions to return (default 30)', '30')
      .option('--columns <cols>', 'Comma-separated columns to display')
      .option('--profile <name>', 'Profile to use')
      .option('--json', 'Output as JSON')
      .option('-o, --output <format>', 'Output format (table|json|csv)', 'table');
  const listSubmissionsAction = async (
    webhookArg: string,
    options: {
      since?: string;
      until?: string;
      limit: string;
      columns?: string;
      profile?: string;
      json?: boolean;
      output?: 'table' | 'json' | 'csv';
    },
  ): Promise<void> => {
    try {
      const client = await getClient(options.profile);
      const resolved = await resolveWebhook(client, webhookArg);

      const params = new URLSearchParams({ limit: options.limit });
      if (options.since) params.set('dateFrom', parseSince(options.since, '--since'));
      if (options.until) params.set('dateTo', parseSince(options.until, '--until'));

      const raw = await client.get(
        `/inbound-webhooks/${resolved.id}/submissions?${params.toString()}`,
      );
      const flattened = unwrapArray<Record<string, unknown>>(raw, ['submissions', 'data']).map(
        flattenSubmission,
      );

      const outFormat = options.json ? 'json' : options.output || 'table';
      if (outFormat === 'json') {
        printJson(flattened);
        return;
      }
      if (outFormat === 'csv') {
        const cols = options.columns ? options.columns.split(',') : undefined;
        process.stdout.write(toCsv(flattened, cols));
        return;
      }

      if (flattened.length === 0) {
        process.stdout.write(colors.dim('No submissions found.\n'));
        return;
      }

      const cols = options.columns
        ? options.columns.split(',').map((c) => ({ header: c.toUpperCase(), key: c }))
        : [
            { header: 'ID', key: 'id', format: (v: unknown) => colors.dim(String(v)) },
            {
              header: 'RECEIVED',
              key: 'receivedAt',
              format: (v: unknown) => formatAge(typeof v === 'string' ? v : undefined),
            },
            {
              header: 'DATA SUMMARY',
              format: (_: unknown, r: Record<string, unknown>) => {
                const entries = Object.entries(r).filter(([k]) => k !== 'id' && k !== 'receivedAt');
                return entries
                  .slice(0, 3)
                  .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                  .join(' ');
              },
            },
          ];

      printTable({
        columns: cols,
        data: flattened,
      });
    } catch (err) {
      exitWithError('webhook submissions', err);
    }
  };

  submissionsListOptions(submissionsCmd.command('list <webhook>').alias('ls'))
    .description('List submissions received by an inbound webhook')
    .action(listSubmissionsAction);

  // `webhook submissions <webhook>` keeps working as the shorthand for list.
  submissionsListOptions(submissionsCmd.command('of <webhook>', { isDefault: true }))
    .description('List submissions (shorthand for: submissions list)')
    .action(listSubmissionsAction);

  // webhook submission <webhook> <submission-id>
  webhook
    .command('submission <webhook> <submissionId>')
    .description('Inspect a single webhook submission')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (
        webhookArg: string,
        submissionId: string,
        options: { profile?: string; json?: boolean },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveWebhook(client, webhookArg);
          const sub = await client.get<Record<string, unknown>>(
            `/inbound-webhooks/${resolved.id}/submissions/${submissionId}`,
          );

          if (options.json) {
            printJson(sub);
            return;
          }

          printKeyValue(flattenSubmission(sub));
        } catch (err) {
          exitWithError('webhook submission', err);
        }
      },
    );

  // webhook submissions export <webhook> [-o csv|json] [--file <path>]
  submissionsCmd
    .command('export <webhook>')
    .description('Export all submissions for a webhook to CSV or JSON')
    .option('-o, --output <format>', 'Export format (csv|json)', 'csv')
    .option('--file <path>', 'Destination file path')
    .option('--force', 'Overwrite the destination file if it exists')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (
        webhookArg: string,
        options: {
          output?: 'csv' | 'json';
          file?: string;
          force?: boolean;
          profile?: string;
        },
      ) => {
        try {
          const client = await getClient(options.profile);
          const resolved = await resolveWebhook(client, webhookArg);
          const pageSize = 200;
          const rows: Record<string, unknown>[] = [];
          for (let offset = 0; offset < pageSize * 100; offset += pageSize) {
            const raw = await client.get(
              `/inbound-webhooks/${resolved.id}/submissions?limit=${pageSize}&offset=${offset}`,
            );
            const page = unwrapArray<Record<string, unknown>>(raw, ['submissions', 'data']);
            rows.push(...page);
            const total =
              raw && typeof raw === 'object' && 'total' in raw
                ? Number((raw as { total?: number }).total)
                : undefined;
            if (page.length < pageSize || (total !== undefined && rows.length >= total)) {
              break;
            }
          }

          const flattened = rows.map(flattenSubmission);
          const format = options.output || 'csv';
          const content = format === 'json' ? JSON.stringify(flattened, null, 2) : toCsv(flattened);
          const target =
            options.file ||
            `submissions-${resolved.slug}-${new Date().toISOString().slice(0, 10)}.${format}`;

          if (options.file && !options.force && existsSync(options.file)) {
            throw new CliError(
              `File "${options.file}" already exists\n  hint: pass --force to overwrite`,
              ExitCode.Rejected,
            );
          }
          // Submissions can hold personal information: owner-only mode.
          await writeFile(target, content, { encoding: 'utf8', mode: 0o600 });
          printSuccess(`Exported ${flattened.length} submission(s) to ${target}`);
        } catch (err) {
          exitWithError('webhook submissions export', err);
        }
      },
    );

  // webhook watch <webhook> [--json]
  webhook
    .command('watch <webhook>')
    .description('Stream incoming webhook submissions in real time')
    .option('--json', 'Stream NDJSON (newline-delimited JSON)')
    .option('--profile <name>', 'Profile to use')
    .action(async (webhookArg: string, options: { json?: boolean; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveWebhook(client, webhookArg);

        if (!options.json) {
          process.stdout.write(
            `Watching submissions for "${colors.bold(resolved.name)}" (Ctrl+C to stop)...\n\n`,
          );
        }

        const seenIds = new Set<string>();

        // Initial fetch to populate seen set
        const initial = await client
          .get(`/inbound-webhooks/${resolved.id}/submissions?limit=20`)
          .catch(() => []);
        for (const s of unwrapArray<Record<string, unknown>>(initial, ['submissions', 'data'])) {
          if (typeof s['id'] === 'string') seenIds.add(s['id']);
        }

        const interval = setInterval(async () => {
          try {
            const fresh = unwrapArray<Record<string, unknown>>(
              await client.get(`/inbound-webhooks/${resolved.id}/submissions?limit=20`),
              ['submissions', 'data'],
            );
            {
              for (const row of fresh) {
                const id = String(row['id'] || '');
                if (id && !seenIds.has(id)) {
                  seenIds.add(id);
                  if (options.json) {
                    process.stdout.write(JSON.stringify(row) + '\n');
                  } else {
                    const time = formatAge(
                      typeof row['receivedAt'] === 'string' ? row['receivedAt'] : undefined,
                    );
                    const flat = flattenSubmission(row);
                    const fields = Object.entries(flat)
                      .filter(([k]) => k !== 'id' && k !== 'receivedAt')
                      .slice(0, 3)
                      .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
                      .join(' ');
                    process.stdout.write(`  [${colors.dim(time)}] ${colors.bold(id)}: ${fields}\n`);
                  }
                }
              }
            }
          } catch {
            // ignore momentary network drops while watching
          }
        }, 2000);

        process.on('SIGINT', () => {
          clearInterval(interval);
          if (!options.json) process.stdout.write('\nStopped watching.\n');
          process.exit(0);
        });
      } catch (err) {
        exitWithError('webhook watch', err);
      }
    });

  // webhook docs <webhook> [--file <path>]
  webhook
    .command('docs <webhook>')
    .description('View or download Markdown integration docs for a webhook')
    .option('--file <path>', 'Save docs to file')
    .option('--profile <name>', 'Profile to use')
    .action(async (webhookArg: string, options: { file?: string; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        const resolved = await resolveWebhook(client, webhookArg);
        const res = await client.get<string | { markdown?: string }>(
          `/admin/inbound-webhooks/${resolved.id}/docs`,
        );

        const md = typeof res === 'string' ? res : res.markdown || JSON.stringify(res, null, 2);

        if (options.file) {
          await writeFile(options.file, md, 'utf8');
          printSuccess(`Integration documentation saved to ${options.file}`);
        } else {
          process.stdout.write(md + '\n');
        }
      } catch (err) {
        exitWithError('webhook docs', err);
      }
    });

  // webhook settings get / set
  const whSettings = webhook.command('settings').description('Inbound webhook global settings');

  whSettings
    .command('get')
    .description('View webhook global settings')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const s = await client.get<Record<string, unknown>>('/admin/inbound-webhooks/settings');
        printJson(s);
      } catch (err) {
        exitWithError('webhook settings get', err);
      }
    });

  whSettings
    .command('set')
    .description('Update webhook settings')
    .requiredOption('--reader-role <roleIds...>', 'Allowed reader role IDs')
    .option('--profile <name>', 'Profile to use')
    .action(async (options: { readerRole: string[]; profile?: string }) => {
      try {
        const client = await getClient(options.profile);
        await client.put('/admin/inbound-webhooks/settings', {
          defaultReaderRoleIds: options.readerRole,
        });
        printSuccess('Inbound webhook settings updated');
      } catch (err) {
        exitWithError('webhook settings set', err);
      }
    });

  // webhook readable
  webhook
    .command('readable')
    .description('List webhooks the current member has permission to read')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(async (options: { profile?: string; json?: boolean }) => {
      try {
        const client = await getClient(options.profile);
        const list = await client.get<Record<string, unknown>[]>('/inbound-webhooks');

        if (options.json) {
          printJson(list);
          return;
        }

        printTable({
          columns: [
            { header: 'ID', key: 'id', format: (v) => colors.dim(String(v)) },
            { header: 'NAME', key: 'name', format: (v) => colors.bold(String(v)) },
            { header: 'SLUG', key: 'slug' },
            { header: 'PROJECT', key: 'projectId', format: (v) => colors.dim(String(v)) },
          ],
          data: list,
        });
      } catch (err) {
        exitWithError('webhook readable', err);
      }
    });
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

async function resolveWebhookId(
  profileFlag: string | undefined,
  idOrSlug: string,
): Promise<string> {
  const client = await getClient(profileFlag);
  return (await resolveWebhook(client, idOrSlug)).id;
}

async function getClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}

async function getStoredSigningSecret(
  config: ReturnType<typeof loadConfig> extends Promise<infer T> ? T : never,
  profileName: string,
  webhookId: string,
): Promise<string> {
  const profile = config.profiles[profileName];
  const stored = profile?.webhookSecrets;
  if (!stored || !(webhookId in stored)) {
    throw new CliError(
      `No signing secret found locally for webhook "${webhookId}"\n  hint: rotate the secret with \`mcid-cli webhook rotate-secret ${webhookId}\``,
      ExitCode.NotFound,
    );
  }
  const entry = stored[webhookId];
  if (!entry) throw new CliError('Signing secret not found', ExitCode.NotFound);
  const keys = defaultKeyProvider();
  return decrypt(entry.secret, keys, webhookSecretContext(profileName, webhookId));
}

function flattenSubmission(row: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: row['id'],
    receivedAt: row['receivedAt'] || row['createdAt'],
  };

  const data = (row['data'] || row['payload'] || {}) as Record<string, unknown>;
  const flattenObject = (obj: Record<string, unknown>, prefix = '') => {
    for (const [key, val] of Object.entries(obj)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenObject(val as Record<string, unknown>, fullKey);
      } else {
        result[fullKey] = val;
      }
    }
  };

  if (typeof data === 'object' && data !== null) {
    flattenObject(data);
  }

  return result;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buf += chunk;
    });
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}
