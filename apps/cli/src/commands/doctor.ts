import { stat } from 'node:fs/promises';
import { Command } from 'commander';
import { configDir, configPath, loadConfig } from '../config.js';
import { defaultKeyProvider, encrypt, decrypt } from '../crypto-store.js';
import { ExitCode, exitWithError } from '../errors.js';
import { colors } from '../lib/tui.js';
import { resolveSession } from '../session.js';

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
  fix?: string;
}

export function registerDoctorCommand(program: Command): void {
  program
    .command('doctor')
    .description('Check local configuration, credentials, and API reachability')
    .option('--profile <name>', 'Profile to test')
    .action(async (options: { profile?: string }) => {
      try {
        const allPassed = await runDoctor(options.profile);
        if (!allPassed) process.exitCode = ExitCode.Unexpected;
      } catch (err) {
        exitWithError('doctor', err);
      }
    });
}

export async function runDoctor(profileFlag?: string | undefined): Promise<boolean> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    return await runDoctorChecks(profileFlag).finally(() => {
      if (process.exitCode === undefined) process.exitCode = previousExitCode;
    });
  } catch (err) {
    process.exitCode = previousExitCode;
    throw err;
  }
}

async function runDoctorChecks(profileFlag?: string | undefined): Promise<boolean> {
  process.stdout.write(`${colors.bold('Running mcid-cli diagnostics...')}\n\n`);
  const checks: CheckResult[] = [];

  // 1. Node.js version check
  const nodeVersion = process.versions.node;
  const [majorStr = '0'] = nodeVersion.split('.');
  const major = parseInt(majorStr, 10);
  if (major >= 22) {
    checks.push({
      name: 'Node.js runtime',
      passed: true,
      message: `Node.js v${nodeVersion} (compatible >=22)`,
    });
  } else if (major >= 20) {
    checks.push({
      name: 'Node.js runtime',
      passed: true,
      message: `Node.js v${nodeVersion} (supported >=20, recommend >=22)`,
    });
  } else {
    checks.push({
      name: 'Node.js runtime',
      passed: false,
      message: `Node.js v${nodeVersion} is below minimum supported version (20+)`,
      fix: 'Upgrade Node.js to version 22 or newer',
    });
  }

  // 2. Config file & directory check
  const cfgPath = configPath();
  try {
    const s = await stat(cfgPath);
    // On POSIX check file mode 0600
    if (process.platform !== 'win32') {
      const mode = s.mode & 0o777;
      if (mode === 0o600) {
        checks.push({
          name: 'Config file permissions',
          passed: true,
          message: `${cfgPath} (mode 0600, secure)`,
        });
      } else {
        checks.push({
          name: 'Config file permissions',
          passed: false,
          message: `${cfgPath} has loose permissions (${mode.toString(8)})`,
          fix: `Run: chmod 600 ${cfgPath}`,
        });
      }
    } else {
      checks.push({
        name: 'Config file',
        passed: true,
        message: `${cfgPath} exists`,
      });
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      checks.push({
        name: 'Config file',
        passed: true,
        message: `${cfgPath} (will be created on first login)`,
      });
    } else {
      checks.push({
        name: 'Config file',
        passed: false,
        message: `Cannot access ${cfgPath}: ${(err as Error).message}`,
        fix: `Check directory permissions for ${configDir()}`,
      });
    }
  }

  // 3. Keychain and Crypto Store
  const keys = defaultKeyProvider();
  try {
    const testSecret = 'doctor-probe-' + Date.now();
    const encrypted = await encrypt(testSecret, keys, 'doctor-check');
    const decrypted = await decrypt(encrypted, keys, 'doctor-check');
    if (decrypted === testSecret) {
      checks.push({
        name: 'Crypto store & keychain',
        passed: true,
        message: 'Credentials storage encryption and decryption verified',
      });
    } else {
      checks.push({
        name: 'Crypto store & keychain',
        passed: false,
        message: 'Decrypted test payload does not match original',
        fix: 'Inspect system keychain access or key file permissions',
      });
    }
  } catch (err) {
    checks.push({
      name: 'Crypto store & keychain',
      passed: false,
      message: `Failed crypto probe: ${(err as Error).message}`,
      fix: 'Ensure your OS keychain service or user home directory is writable',
    });
  }

  // 4. API reachability and Session check
  try {
    const config = await loadConfig();
    const profileName = profileFlag || config.activeProfile || 'default';
    const profile = config.profiles[profileName];

    if (!profile && !process.env.MCID_TOKEN) {
      checks.push({
        name: 'Profile & Session',
        passed: false,
        message: `Profile "${profileName}" is not configured yet`,
        fix: `Run: mcid-cli login --profile ${profileName} --base-url <url>`,
      });
    } else {
      const session = await resolveSession(config, profileName, keys);

      // Probe liveness on the unauthenticated API root: the health endpoint
      // needs monitoring:read, which a valid admin may legitimately lack.
      try {
        const rootUrl = `${session.baseUrl}/api`;
        const res = await fetch(rootUrl, {
          signal: AbortSignal.timeout(5000),
          headers: { Accept: 'application/json' },
        });

        if (res.ok || res.status === 404) {
          checks.push({
            name: 'API reachability',
            passed: true,
            message: `Connected to ${session.baseUrl} (HTTP ${res.status})`,
          });
        } else {
          checks.push({
            name: 'API reachability',
            passed: false,
            message: `MCID server at ${session.baseUrl} returned HTTP ${res.status}`,
            fix: 'Check server status or base URL in profile',
          });
        }
      } catch (err) {
        checks.push({
          name: 'API reachability',
          passed: false,
          message: `Cannot connect to ${session.baseUrl}: ${(err as Error).message}`,
          fix: 'Verify the server URL and check your network connection',
        });
      }

      // Check session validity
      try {
        const meUrl = `${session.baseUrl}/api/auth/admin/me`;
        const res = await fetch(meUrl, {
          signal: AbortSignal.timeout(5000),
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${session.token}`,
          },
        });

        if (res.ok) {
          checks.push({
            name: 'Session authentication',
            passed: true,
            message: `Active session valid on profile "${profileName}"`,
          });
        } else if (res.status === 401) {
          checks.push({
            name: 'Session authentication',
            passed: false,
            message: 'Session has expired or was revoked',
            fix: `Run: mcid-cli login --profile ${profileName}`,
          });
        } else if (res.status === 403) {
          checks.push({
            name: 'Session authentication',
            passed: false,
            message: 'Account lacks admin access permissions',
            fix: 'Contact a Discord executive to grant admin access in MCID',
          });
        } else {
          checks.push({
            name: 'Session authentication',
            passed: false,
            message: `Unexpected auth response: HTTP ${res.status}`,
          });
        }
      } catch (err) {
        checks.push({
          name: 'Session authentication',
          passed: false,
          message: `Failed checking session: ${(err as Error).message}`,
        });
      }
    }
  } catch (err) {
    checks.push({
      name: 'Session check',
      passed: false,
      message: (err as Error).message,
    });
  }

  // Print results
  let allPassed = true;
  for (const check of checks) {
    if (check.passed) {
      process.stdout.write(`  ${colors.green('✓')} ${check.name}: ${check.message}\n`);
    } else {
      allPassed = false;
      process.stdout.write(`  ${colors.red('✗')} ${check.name}: ${check.message}\n`);
      if (check.fix) {
        process.stdout.write(`    ${colors.dim(`hint: ${check.fix}`)}\n`);
      }
    }
  }

  process.stdout.write('\n');
  if (allPassed) {
    process.stdout.write(`${colors.green('✓ All checks passed! mcid-cli is ready.')}\n`);
  } else {
    process.stdout.write(`${colors.yellow('! Some checks failed. See hints above.')}\n`);
  }

  return allPassed;
}
