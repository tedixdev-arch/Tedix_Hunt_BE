import { describe, expect, it } from 'vitest';
import { meetsPasswordPolicy } from './passwordPolicy.js';

describe('password policy', () => {
  it.each(['Test123!', 'abc12345#'])('accepts %s', (password) => {
    expect(meetsPasswordPolicy(password)).toBe(true);
  });

  it.each(['password', 'password1', 'password!', '12345678!', 'Abc1!'])(
    'rejects %s',
    (password) => expect(meetsPasswordPolicy(password)).toBe(false),
  );

  it('does not trim or otherwise transform passwords', () => {
    expect(meetsPasswordPolicy(' Abc123!')).toBe(true);
  });
});
