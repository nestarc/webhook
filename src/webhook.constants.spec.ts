import { DEFAULT_USER_AGENT } from './webhook.constants';

const { version } = require('../package.json') as { version: string };

describe('webhook constants', () => {
  it('includes the package version in the default user agent', () => {
    expect(DEFAULT_USER_AGENT).toBe(`@nestarc/webhook/${version}`);
  });
});
