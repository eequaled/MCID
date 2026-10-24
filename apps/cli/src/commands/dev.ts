import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { Command } from 'commander';
import { openBrowser } from '../browser.js';
import { configPath, loadConfig, normalizeBaseUrl, resolveProfileName } from '../config.js';
import { defaultKeyProvider } from '../crypto-store.js';
import { CliError, ExitCode, exitWithError } from '../errors.js';
import { ApiClient } from '../lib/client.js';
import { formatDate, printJson, printKeyValue, printSuccess } from '../lib/output.js';
import { resolveMember, resolveProject, resolveServer } from '../lib/resolver.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

export interface ProjectKeyLookup {
  apiKey: string;
  source: string;
  projectId?: string;
  serverId?: string;
  baseUrl?: string;
}

/** Minimal HTML escaping for the one string the callback page reflects. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function registerDevCommand(program: Command): void {
  const devCmd = program
    .command('dev')
    .description('Developer commands to test project SSO, tokens, and permissions end to end');

  // dev sso [--project <p>] [--port 3000] [--silent] [--reveal]
  devCmd
    .command('sso')
    .description('Test SSO authorization flow end to end with a local callback listener')
    .requiredOption('--project <project>', 'Target project name or ID')
    .option('--server <server>', 'Discord server to authenticate against')
    .option('--port <port>', 'Local callback listener port (default 3000)', '3000')
    .option(
      '--timeout <seconds>',
      'How long to wait for the SSO callback before giving up (default 300)',
      '300',
    )
    .option('--silent', 'Test silent login (prompt=none)')
    .option('--reveal', 'Print the full session token')
    .option('--api-key <key>', 'Explicit project API key')
    .option('--profile <name>', 'Profile for base URL')
    .option('--json', 'Output as JSON')
    .action(
      async (options: {
        project?: string;
        server?: string;
        port: string;
        timeout: string;
        silent?: boolean;
        reveal?: boolean;
        apiKey?: string;
        profile?: string;
        json?: boolean;
      }) => {
        try {
          const port = parseInt(options.port, 10);
          const redirectUri = `http://localhost:${port}/callback`;

          // 1. Resolve project key and base URL
          const keyInfo = await resolveProjectKey(options.apiKey, options.profile);
          if (!options.project) {
            throw new CliError('dev sso requires --project <project>', ExitCode.Usage);
          }
          const adminClient = await getAdminClient(options.profile);
          const baseUrl = keyInfo.baseUrl || adminClient.origin;
          const project = await resolveProject(adminClient, options.project);
          const projectInfo = await adminClient.get<{ redirectUri?: string | null }>(
            `/admin/projects/${project.id}`,
          );
          const allowedRedirectUris = (projectInfo.redirectUri ?? '')
            .split(',')
            .map((uri) => uri.trim())
            .filter(Boolean);
          if (!allowedRedirectUris.includes(redirectUri)) {
            throw new CliError(
              `Redirect URI "${redirectUri}" is not registered for project "${project.name}"\n  hint: run \`mcid-cli project redirect-uri add ${project.id} ${redirectUri}\``,
              ExitCode.Rejected,
            );
          }
          const grants = await adminClient.get<{ serverId: string }[]>(
            `/admin/projects/${project.id}/servers`,
          );
          let serverId = options.server
            ? (await resolveServer(adminClient, options.server)).id
            : (await resolveServer(adminClient)).id;
          if (!grants.some((grant) => grant.serverId === serverId)) {
            const firstGrant = grants[0];
            if (options.server || !firstGrant) {
              throw new CliError(
                `Project "${project.name}" has no access to the selected server. Grant project server access first.`,
                ExitCode.Rejected,
              );
            }
            serverId = firstGrant.serverId;
          }

          process.stdout.write(
            `${colors.bold('Testing MCID Project SSO')} [key source: ${colors.cyan(keyInfo.source)}]\n\n`,
          );

          const state = randomBytes(24).toString('base64url');

          // 3. Start local callback listener
          let resolveCallback: (code: string) => void;
          let rejectCallback: (err: Error) => void;
          const callbackPromise = new Promise<string>((res, rej) => {
            resolveCallback = res;
            rejectCallback = rej;
          });

          const server = createServer((req, res) => {
            try {
              const reqUrl = new URL(req.url || '/', `http://localhost:${port}`);
              if (reqUrl.pathname === '/callback') {
                const code = reqUrl.searchParams.get('code');
                const returnedState = reqUrl.searchParams.get('state');
                const error = reqUrl.searchParams.get('error');

                if (error) {
                  res.writeHead(400, { 'Content-Type': 'text/html' });
                  res.end(`<h3>MCID SSO Error: ${escapeHtml(error)}</h3>`);
                  rejectCallback(new CliError(`SSO returned error: ${error}`, ExitCode.Rejected));
                  return;
                }

                if (!code || returnedState !== state) {
                  res.writeHead(400, { 'Content-Type': 'text/html' });
                  res.end('<h3>Invalid callback parameters</h3>');
                  rejectCallback(
                    new CliError('Callback missing code or state mismatch', ExitCode.Rejected),
                  );
                  return;
                }

                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(
                  '<h3>SSO successful! You can close this tab and return to your terminal.</h3>',
                );
                resolveCallback(code);
              } else {
                res.writeHead(404);
                res.end();
              }
            } catch (err) {
              rejectCallback(err as Error);
            }
          });

          // Loopback only: the callback carries a one-time auth code, it must
          // not be reachable from the network like login-flow's listener.
          await new Promise<void>((res, rej) => {
            server.listen(port, '127.0.0.1', () => res());
            server.once('error', rej);
          });

          const authParams = new URLSearchParams({
            client_id: project.id,
            redirect_uri: redirectUri,
            server_id: serverId,
            state,
            ...(options.silent ? { prompt: 'none' } : {}),
          });

          const authorizeUrl = `${baseUrl}/api/auth/sso/authorize?${authParams.toString()}`;

          process.stdout.write(`  ${colors.cyan('1. Authorize')} -> Listening on ${redirectUri}\n`);

          if (options.silent) {
            process.stdout.write(`  Testing silent authorization (prompt=none)...\n`);
          } else {
            process.stdout.write(`  Opening browser to sign in: ${colors.dim(authorizeUrl)}\n`);
            await openBrowser(authorizeUrl);
          }

          let code: string;
          const timeoutMs = Math.max(1, Number(options.timeout) || 300) * 1000;
          try {
            code = await Promise.race([
              callbackPromise,
              new Promise<never>((_, reject) =>
                setTimeout(
                  () =>
                    reject(
                      new CliError(
                        `SSO callback timed out after ${options.timeout}s -- no authorization code arrived`,
                        ExitCode.Rejected,
                      ),
                    ),
                  timeoutMs,
                ).unref?.(),
              ),
            ]);
          } finally {
            server.close();
          }

          process.stdout.write(
            `  ${colors.green('2. Callback received')} with authorization code\n`,
          );

          // 4. Exchange code for session token
          process.stdout.write(`  ${colors.cyan('3. Exchanging code for token')}...\n`);
          const tokenRes = await fetch(`${baseUrl}/api/auth/token`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': keyInfo.apiKey,
            },
            body: JSON.stringify({
              clientId: project.id,
              code,
              redirectUri,
            }),
          });

          if (!tokenRes.ok) {
            const bodyText = await tokenRes.text();
            throw new CliError(
              `Token exchange failed (HTTP ${tokenRes.status}): ${bodyText}`,
              ExitCode.Rejected,
            );
          }

          const sessionData = (await tokenRes.json()) as {
            token?: string;
            accessToken?: string;
            expiresAt?: string;
          };
          const token = sessionData.token || sessionData.accessToken || '';
          process.stdout.write(`  ${colors.green('4. Token exchange successful')}\n`);

          // 5. Validate session token to fetch member & roles
          process.stdout.write(`  ${colors.cyan('5. Validating token')}...\n`);
          const validateRes = await fetch(`${baseUrl}/api/auth/validate`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-API-Key': keyInfo.apiKey,
            },
            body: JSON.stringify({ token }),
          });

          if (!validateRes.ok) {
            const bodyText = await validateRes.text();
            throw new CliError(
              `Token validation failed (HTTP ${validateRes.status}): ${bodyText}`,
              ExitCode.Rejected,
            );
          }

          const validateData = await validateRes.json();
          process.stdout.write(`  ${colors.green('6. Validation successful!')}\n\n`);

          if (options.json) {
            printJson({ session: sessionData, member: validateData }, options.reveal);
            return;
          }

          printSuccess('SSO Authentication Flow Complete');
          printKeyValue({
            'Token Status': colors.green('valid'),
            Token: options.reveal ? token : `${token.slice(0, 10)}... [pass --reveal to show full]`,
            Expires: formatDate(sessionData.expiresAt),
          });

          process.stdout.write('\n');
          printJson(validateData);
        } catch (err) {
          exitWithError('dev sso', err);
        }
      },
    );

  // dev token validate|refresh — real nested subcommands (a space alias can
  // never match, commander compares one argv token), with the hyphenated
  // spellings kept as shorthands.
  const tokenCmd = devCmd
    .command('token')
    .description('Validate and refresh project session tokens');

  const tokenValidateAction = async (
    token: string,
    options: { apiKey?: string; profile?: string; json?: boolean },
  ): Promise<void> => {
    try {
      const keyInfo = await resolveProjectKey(options.apiKey, options.profile);
      const baseUrl = keyInfo.baseUrl || (await resolveApiBaseUrl(options.profile));

      const res = await fetch(`${baseUrl}/api/auth/validate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key': keyInfo.apiKey,
        },
        body: JSON.stringify({ token }),
      });

      if (!res.ok) {
        throw new CliError(
          `Session token is invalid or expired (HTTP ${res.status})`,
          ExitCode.Auth,
        );
      }

      const data = await res.json();
      if (options.json) {
        printJson(data);
        return;
      }

      printSuccess('Token is valid');
      printJson(data);
    } catch (err) {
      exitWithError('dev token validate', err);
    }
  };

  const tokenValidateOptions = (cmd: Command) =>
    cmd
      .option('--api-key <key>', 'Project API key')
      .option('--profile <name>', 'Profile to use')
      .option('--json', 'Output as JSON');

  tokenValidateOptions(tokenCmd.command('validate <token>'))
    .description('Validate a session token using project API key')
    .action(tokenValidateAction);
  tokenValidateOptions(devCmd.command('token-validate <token>'))
    .description(
      'Validate a session token using project API key (shorthand for: dev token validate)',
    )
    .action(tokenValidateAction);

  const tokenRefreshAction = async (
    refreshToken: string,
    options: { token?: string; profile?: string; reveal?: boolean; json?: boolean },
  ): Promise<void> => {
    try {
      const cfg = await loadConfig(configPath());
      const profile = resolveProfileName(cfg, options.profile);
      const baseUrl = normalizeBaseUrl(
        process.env.MCID_API_URL || cfg.profiles[profile]?.baseUrl || 'http://localhost:3000',
      );
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${options.token}`,
      };

      const res = await fetch(`${baseUrl}/api/auth/token/refresh`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ refreshToken }),
      });

      if (!res.ok) {
        throw new CliError(`Refresh failed (HTTP ${res.status})`, ExitCode.Auth);
      }

      const data = await res.json();
      // The old pair is already invalidated server-side; masking the new one
      // would leave the operator with no usable token at all.
      if (options.json) {
        printJson(data, true);
        return;
      }

      printSuccess(
        'Session refreshed successfully; the new token pair follows (the old one is now invalid)',
      );
      printJson(data, true);
    } catch (err) {
      exitWithError('dev token refresh', err);
    }
  };

  const tokenRefreshOptions = (cmd: Command) =>
    cmd
      .requiredOption('--token <sessionToken>', 'Active session token')
      .option('--profile <name>', 'Profile to use')
      .option('--json', 'Output as JSON');

  tokenRefreshOptions(tokenCmd.command('refresh <refreshToken>'))
    .description('Refresh an active session using refresh token')
    .action(tokenRefreshAction);
  tokenRefreshOptions(devCmd.command('token-refresh <refreshToken>'))
    .description('Refresh an active session using refresh token (shorthand for: dev token refresh)')
    .action(tokenRefreshAction);

  // dev check <member> <permissions...> [--server <s>]
  devCmd
    .command('check <member> <permissions...>')
    .description('Check permissions for a member on a server using project API key')
    .option('--server <server>', 'Context Discord server (defaults to main server)')
    .option('--api-key <key>', 'Project API key')
    .option('--profile <name>', 'Profile to use')
    .option('--json', 'Output as JSON')
    .action(
      async (
        memberArg: string,
        permArgs: string[],
        options: { server?: string; apiKey?: string; profile?: string; json?: boolean },
      ) => {
        try {
          const keyInfo = await resolveProjectKey(options.apiKey, options.profile);
          const baseUrl = keyInfo.baseUrl || (await resolveApiBaseUrl(options.profile));

          const snowflake = /^\d{17,20}$/;
          let resolvedServer: { id: string; name: string };
          let resolvedMember: { discordId: string; username: string };
          const explicitServer = options.server;
          if (explicitServer && snowflake.test(explicitServer) && snowflake.test(memberArg)) {
            resolvedServer = { id: explicitServer, name: explicitServer };
            resolvedMember = { discordId: memberArg, username: memberArg };
          } else {
            const client = await getAdminClient(options.profile);
            resolvedServer = await resolveServer(client, options.server);
            resolvedMember = await resolveMember(client, memberArg);
          }

          let anyDenied = false;
          const results: Record<string, boolean> = {};

          if (permArgs.length === 1) {
            const perm = permArgs[0]!;
            const res = await fetch(`${baseUrl}/api/permissions/check`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': keyInfo.apiKey,
              },
              body: JSON.stringify({
                discordId: resolvedMember.discordId,
                serverId: resolvedServer.id,
                permission: perm,
              }),
            });

            if (!res.ok) {
              throw new CliError(`Permission check failed (HTTP ${res.status})`, ExitCode.Rejected);
            }

            const checkData = (await res.json()) as { allowed: boolean };
            results[perm] = checkData.allowed;
            if (!checkData.allowed) anyDenied = true;
          } else {
            const res = await fetch(`${baseUrl}/api/permissions/check-batch`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'X-API-Key': keyInfo.apiKey,
              },
              body: JSON.stringify({
                discordId: resolvedMember.discordId,
                serverId: resolvedServer.id,
                permissions: permArgs,
                mode: 'ALL',
              }),
            });

            if (!res.ok) {
              throw new CliError(
                `Batch permission check failed (HTTP ${res.status})`,
                ExitCode.Rejected,
              );
            }

            const batchData = (await res.json()) as { allowed: boolean; missing?: string[] };
            const missing = new Set(
              (batchData.missing ?? []).map((permission) => permission.toUpperCase()),
            );
            for (const permission of permArgs) {
              results[permission] = !missing.has(permission.toUpperCase());
            }
            anyDenied = !batchData.allowed;
          }

          if (options.json) {
            printJson({ member: resolvedMember, server: resolvedServer, results });
            if (anyDenied) process.exitCode = ExitCode.PrecheckFailed;
            return;
          }

          process.stdout.write(
            `Permission check for ${colors.bold(`@${resolvedMember.username}`)} on ${colors.bold(resolvedServer.name)}:\n\n`,
          );

          for (const [perm, allowed] of Object.entries(results)) {
            if (allowed) {
              process.stdout.write(`  ${colors.green('✓')} ${perm}: ${colors.green('allowed')}\n`);
            } else {
              process.stdout.write(`  ${colors.red('✗')} ${perm}: ${colors.red('denied')}\n`);
            }
          }

          if (anyDenied) {
            process.exitCode = ExitCode.PrecheckFailed;
          }
        } catch (err) {
          exitWithError('dev check', err);
        }
      },
    );

  // dev env [--project <p>] [--file .env]
  devCmd
    .command('env')
    .description('Print or write the .env block for a project')
    .option('--project <project>', 'Project name or ID')
    .option('--file <path>', 'Destination .env file')
    .option('--api-key <key>', 'Project API key')
    .option('--profile <name>', 'Profile to use')
    .action(
      async (options: { project?: string; file?: string; apiKey?: string; profile?: string }) => {
        try {
          const keyInfo = await resolveProjectKey(options.apiKey, options.profile, options.project);
          const baseUrl = keyInfo.baseUrl || (await resolveApiBaseUrl(options.profile));

          const envBlock = [
            `MCID_API_URL=${baseUrl}/api`,
            `MCID_API_KEY=${keyInfo.apiKey}`,
            `MCID_REDIRECT_URI=http://localhost:3000/callback`,
          ].join('\n');

          if (options.file) {
            await writeFile(options.file, `${envBlock}\n`, { encoding: 'utf8', mode: 0o600 });
            printSuccess(`Wrote project configuration to ${options.file}`);
          } else {
            process.stdout.write(`${envBlock}\n`);
          }
        } catch (err) {
          exitWithError('dev env', err);
        }
      },
    );
}

export async function resolveProjectKey(
  flagKey?: string,
  profileFlag?: string,
  projectArg?: string,
): Promise<ProjectKeyLookup> {
  const baseUrl = await resolveApiBaseUrl(profileFlag);
  // 1. --api-key flag
  if (flagKey) {
    return { apiKey: flagKey, source: '--api-key flag', baseUrl };
  }

  // 2. MCID_API_KEY env var
  if (process.env.MCID_API_KEY) {
    return { apiKey: process.env.MCID_API_KEY, source: 'MCID_API_KEY env', baseUrl };
  }

  // 3. Local .env file
  try {
    const envContent = await readFile('.env', 'utf8');
    const match = envContent.match(/^MCID_API_KEY=(.+)$/m);
    if (match && match[1]) {
      return { apiKey: match[1].trim(), source: 'local .env file', baseUrl };
    }
  } catch {
    // no .env file
  }

  throw new CliError(
    projectArg
      ? `No recoverable API key is available for project "${projectArg}"\n  hint: pass --api-key <key>, set MCID_API_KEY, or place it in .env`
      : 'No project API key found\n  hint: specify --api-key <key>, set MCID_API_KEY, or place it in .env',
    ExitCode.Usage,
  );
}

async function resolveApiBaseUrl(profileFlag?: string): Promise<string> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  return normalizeBaseUrl(
    process.env.MCID_API_URL || config.profiles[profileName]?.baseUrl || 'http://localhost:3000',
  );
}

async function getAdminClient(profileFlag?: string): Promise<ApiClient> {
  const config = await loadConfig(configPath());
  const profileName = resolveProfileName(config, profileFlag);
  const session = await resolveSession(config, profileName, defaultKeyProvider());
  return new ApiClient(session);
}
