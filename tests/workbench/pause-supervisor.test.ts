import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('checks pause descriptor ownership and runs real kernel cases only on Linux', () => {
  const output = execFileSync('/usr/bin/python3', ['-I', '-B', 'tests/workbench/pause_test.py'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(output).toBe('');
});
