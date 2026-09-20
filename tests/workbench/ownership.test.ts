import { execFileSync } from 'node:child_process';
import { expect, it } from 'vitest';

it.skipIf(process.platform === 'win32')('rejects reused process identities and preserves ambiguous ownership without signalling', () => {
  const output = execFileSync('/usr/bin/python3', ['-I', 'tests/workbench/ownership_test.py'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  expect(output).toBe('');
});
