import * as cp from 'child_process';

export function exec(
  command: string,
  args: string[],
  options: { cwd: string; input?: string },
): Promise<{
  stdout: string;
  stderr: string;
  code: number | null;
  ms: number;
}> {
  return new Promise((res) => {
    const s = process.hrtime();
    const { input, ...rest } = options;
    let stdout: string = '';
    let stderr: string = '';

    const proc = cp.spawn(command, args, { timeout: 5000, ...rest });
    if (typeof input === 'string') proc.stdin.write(input);
    proc.stdin.end();
    proc.stdout.on('data', (data) => (stdout += data.toString()));
    proc.stderr.on('data', (data) => (stderr += data.toString()));
    proc.on('close', (code) => {
      const e = process.hrtime(s);
      const ms = Math.round((e[0] * 1000000000 + e[1]) / 1000000);
      res({ stdout, stderr, code, ms });
    });
  });
}
