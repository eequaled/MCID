import { vi } from 'vitest';
import { Command } from 'commander';
import { ExitCode } from '../errors.js';
import { registerAccessCommand } from '../commands/access.js';
import { registerCompletionCommand } from '../commands/completion.js';
import { registerConfigCommand } from '../commands/config.js';
import { registerDevCommand } from '../commands/dev.js';
import { registerDoctorCommand } from '../commands/doctor.js';
import { registerLoginCommand } from '../commands/login.js';
import { registerLogoutCommand } from '../commands/logout.js';
import { registerMemberCommand } from '../commands/member.js';
import { registerOpsCommand } from '../commands/ops.js';
import { registerOpenCommand } from '../commands/open.js';
import { registerProfileCommand } from '../commands/profile.js';
import { registerProjectCommand } from '../commands/project.js';
import { registerSchemaCommand } from '../commands/schema.js';
import { registerServerCommand } from '../commands/server.js';
import { registerSyncCommand } from '../commands/sync.js';
import { registerWebhookCommand } from '../commands/webhook.js';
import { registerWhoamiCommand } from '../commands/whoami.js';

export type RouteHandler = (url: URL, init: RequestInit) => Response | Promise<Response>;

/** A request the CLI made to the (stubbed) API, in assertion-friendly form. */
export interface RecordedRequest {
  method: string;
  /** Path with the `/api` prefix stripped, no query string. */
  path: string;
  /** Query params; repeated params (e.g. `roleId`) become string arrays. */
  query: Record<string, string | string[]>;
  /** Parsed JSON body when one was sent. */
  body?: unknown;
  headers: Record<string, string>;
}

export interface CliResult {
  /** 0 when nothing failed; the code passed to process.exit / set on process.exitCode / commander usage errors. */
  exitCode: number;
  stdout: string;
  stderr: string;
  requests: RecordedRequest[];
}

export interface RunCliOptions {
  /** Routes keyed by `METHOD /path` (path after `/api`), same as fakeMcid. */
  routes?: Record<string, RouteHandler>;
  env?: Record<string, string | undefined>;
}

/** Sentinel thrown by the process.exit spy so command actions unwind instead of killing the worker. */
class ProcessExitSignal extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

/** Thrown by exitOverride for usage errors and --help, carrying the mapped exit code. */
class CommanderExitError extends Error {
  constructor(readonly code: number) {
    super('commander exit');
  }
}

/** A fresh program with every command registered, mimicking src/index.ts wiring. */
export function buildProgram(): Command {
  const program = new Command();
  program.exitOverride((err) => {
    const done = err.code === 'commander.helpDisplayed' || err.code === 'commander.version';
    throw new CommanderExitError(done || err.exitCode === 0 ? ExitCode.Ok : ExitCode.Usage);
  });
  program.name('mcid-cli').description('MCID command-line client (test harness)');
  registerLoginCommand(program);
  registerLogoutCommand(program);
  registerWhoamiCommand(program);
  registerDoctorCommand(program);
  registerCompletionCommand(program);
  registerOpenCommand(program);
  registerProfileCommand(program);
  registerConfigCommand(program);
  registerSchemaCommand(program);
  registerWebhookCommand(program);
  registerProjectCommand(program);
  registerServerCommand(program);
  registerSyncCommand(program);
  registerMemberCommand(program);
  registerAccessCommand(program);
  registerOpsCommand(program);
  registerDevCommand(program);
  return program;
}

function queryRecord(url: URL): Record<string, string | string[]> {
  const record: Record<string, string | string[]> = {};
  for (const key of new Set(url.searchParams.keys())) {
    const all = url.searchParams.getAll(key);
    record[key] = all.length > 1 ? all : (all[0] as string);
  }
  return record;
}

/** Matches `:param` path segments, e.g. `/admin/servers/:serverId/channels`. */
function findHandler(
  routes: Record<string, RouteHandler>,
  method: string,
  path: string,
): RouteHandler | undefined {
  const exact = routes[`${method} ${path}`];
  if (exact) return exact;
  const segments = path.split('/');
  for (const [key, handler] of Object.entries(routes)) {
    const [keyMethod, ...keyPathParts] = key.split(' ');
    const keyPath = keyPathParts.join(' ');
    if (keyMethod !== method) continue;
    const keySegments = keyPath.split('/');
    if (keySegments.length !== segments.length) continue;
    const matches = keySegments.every(
      (segment, i) => segment.startsWith(':') || segment === segments[i],
    );
    if (matches) return handler;
  }
  return undefined;
}

/**
 * Runs the real CLI (fresh commander program, real command actions) against a
 * fake MCID API. stdout/stderr are captured, `fetch` is stubbed with `routes`
 * (unmatched paths 404 like the real API) and every request is recorded, and
 * process.exit / process.exitCode surface as `exitCode`.
 *
 * Pair with `afterEach(cleanupCliTest)` to undo the stubs and spies.
 */
export async function runCli(args: string[], options: RunCliOptions = {}): Promise<CliResult> {
  const requests: RecordedRequest[] = [];
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  vi.stubEnv('MCID_TOKEN', options.env?.MCID_TOKEN ?? 'test-session-token');
  vi.stubEnv('MCID_API_URL', options.env?.MCID_API_URL ?? 'http://localhost:3000');
  for (const [key, value] of Object.entries(options.env ?? {})) {
    if (key === 'MCID_TOKEN' || key === 'MCID_API_URL') continue;
    if (value !== undefined) vi.stubEnv(key, value);
  }

  const routes = options.routes ?? {};
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, '');
    let body: unknown;
    if (typeof init.body === 'string' && init.body.length > 0) {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    }
    requests.push({
      method: init.method ?? 'GET',
      path,
      query: queryRecord(url),
      body,
      headers: (init.headers ?? {}) as Record<string, string>,
    });
    const handler = findHandler(routes, init.method ?? 'GET', path);
    if (!handler) {
      return new Response(JSON.stringify({ message: 'not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return handler(url, init);
  });

  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ProcessExitSignal(code ?? 0);
  }) as never);

  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let exitCode: number | undefined;

  try {
    // Commander's parse() drops the first two argv elements (node, script).
    await buildProgram().parseAsync(['node', 'mcid-cli', ...args]);
  } catch (err) {
    if (err instanceof ProcessExitSignal) {
      exitCode = err.code;
    } else if (err instanceof CommanderExitError) {
      exitCode = err.code;
    } else {
      throw err;
    }
  } finally {
    if (exitCode === undefined) exitCode = process.exitCode;
    process.exitCode = previousExitCode;
  }

  return {
    exitCode: exitCode ?? ExitCode.Ok,
    stdout: stdoutChunks.join(''),
    stderr: stderrChunks.join(''),
    requests,
  };
}

/** Undoes everything runCli stubbed; call in afterEach. */
export function cleanupCliTest(): void {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
}

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
