export const PASSWORD_POLICY_ERROR = 'password_policy_not_met';
export const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include a letter, a number, and a special character.';

/** Every newly established password must satisfy this single platform-wide policy. */
export const meetsPasswordPolicy = (password: string): boolean =>
  password.length >= 8
  && /[A-Za-z]/.test(password)
  && /\d/.test(password)
  && /[^A-Za-z\d]/.test(password);

export const passwordPolicyError = () => ({
  error: PASSWORD_POLICY_ERROR,
  message: PASSWORD_POLICY_MESSAGE,
});
