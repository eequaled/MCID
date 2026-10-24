import { CliError, ExitCode } from '../errors.js';
import { promptConfirm, promptInput } from './prompts.js';
import { colors } from './tui.js';

export interface ConfirmDestructiveOptions {
  resourceType: string;
  resourceName: string;
  yesFlag?: boolean | undefined;
  action?: string | undefined;
}

export async function confirmDestructive(options: ConfirmDestructiveOptions): Promise<void> {
  const { resourceType, resourceName, yesFlag } = options;

  if (yesFlag) return;

  if (!process.stdin.isTTY) {
    throw new CliError(
      `Destructive command requires confirmation on non-interactive terminal\n  hint: pass --yes to confirm`,
      ExitCode.Usage,
    );
  }

  const action = options.action ?? 'permanently delete';
  process.stdout.write(
    `${colors.yellow('!')} This action cannot be undone. This will ${action} ${resourceType} "${colors.bold(resourceName)}".\n`,
  );

  const answer = await promptInput({
    message: `Type "${resourceName}" to confirm`,
  });

  if (answer !== resourceName) {
    // A cancelled destructive action must not look like success to scripts.
    throw new CliError('Confirmation text did not match; action aborted', ExitCode.Rejected);
  }
}

/** Confirm a state-changing action; unattended callers must opt in explicitly. */
export async function confirmAction(message: string, yesFlag?: boolean): Promise<boolean> {
  if (yesFlag) return true;
  if (!process.stdin.isTTY) {
    throw new CliError(
      `This command requires confirmation on a non-interactive terminal\n  hint: pass --yes to confirm`,
      ExitCode.Usage,
    );
  }
  return promptConfirm({ message });
}
