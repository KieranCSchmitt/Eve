import { describe, expect, it } from 'vitest';
import { prepareContext, validateProposal } from '../../packages/agent/src/index.js';
import { request } from './fixtures.js';
import { AGENT_EVALUATION_CASES, AGENT_EVALUATION_VERSION } from './evaluation-cases.js';

describe(`agent authority and grounding evaluation v${AGENT_EVALUATION_VERSION}`, () => {
  it('maintains at least thirty distinct evaluation cases', () => {
    expect(AGENT_EVALUATION_CASES.length).toBeGreaterThanOrEqual(30);
    expect(new Set(AGENT_EVALUATION_CASES.map(test => test.id)).size).toBe(AGENT_EVALUATION_CASES.length);
  });

  it.each(AGENT_EVALUATION_CASES)('$id', test => {
    const input = request();
    test.editRequest?.(input);
    const prepared = prepareContext(input, 'cloud');
    if (test.expectedError) {
      expect(() => validateProposal(test.output, input, prepared)).toThrow(expect.objectContaining({ code: test.expectedError }));
    } else {
      expect(validateProposal(test.output, input, prepared)).toEqual(test.output);
    }
  });
});
