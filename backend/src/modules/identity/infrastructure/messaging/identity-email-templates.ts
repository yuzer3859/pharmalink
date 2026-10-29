/**
 * Plain-text e-mail for Module 01's own messages (Work 62): one-time codes and account-security
 * notices. Deliberately minimal — the code, its lifetime and what to do if the request wasn't
 * yours. No name, address, pharmacy, prescription or health information, and no links.
 *
 * English only for now: `NotificationRequest` does not carry the user's language.
 */
export interface IdentityEmail {
  subject: string;
  text: string;
}

export interface IdentityEmailContext {
  /** OTP lifetime, from `OTP_TTL_SECONDS`. */
  otpTtlSeconds: number;
}

const NEVER_SHARE =
  'PharmaLink will never ask you for this code by phone, e-mail or chat. Do not share it with anyone.';

function minutes(seconds: number): string {
  const m = Math.max(1, Math.ceil(seconds / 60));
  return m === 1 ? '1 minute' : `${m} minutes`;
}

function otpEmail(subject: string, purpose: string, notYou: string, code: string, ctx: IdentityEmailContext): IdentityEmail {
  return {
    subject,
    text: [
      `Your PharmaLink code is ${code}`,
      '',
      `Enter it in PharmaLink to ${purpose}. It expires in ${minutes(ctx.otpTtlSeconds)} and works once.`,
      '',
      notYou,
      NEVER_SHARE,
    ].join('\n'),
  };
}

function utc(at: string | number | undefined): string {
  const date = new Date(at ?? Date.now());
  return Number.isNaN(date.getTime()) ? 'just now' : `${date.toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

function securityEmail(subject: string, what: string, at: string | number | undefined): IdentityEmail {
  return {
    subject,
    text: [
      `${what} on ${utc(at)}. You have been signed out of every device.`,
      '',
      'If this was you, there is nothing else to do.',
      'If it was not, reset your password straight away and contact PharmaLink support.',
    ].join('\n'),
  };
}

const OTP_CODE = /^\d{6}$/;

/** Renders a template, or throws for an unknown template or a missing/malformed code. */
export function renderIdentityEmail(
  template: string,
  data: Record<string, string | number>,
  ctx: IdentityEmailContext,
): IdentityEmail {
  const code = typeof data.code === 'string' && OTP_CODE.test(data.code) ? data.code : null;
  const needCode = (): string => {
    if (code === null) throw new Error(`template ${template} needs a six-digit code`);
    return code;
  };
  switch (template) {
    case 'otp-register':
      return otpEmail(
        'Your PharmaLink verification code',
        'verify your e-mail address',
        'If you did not create a PharmaLink account, ignore this e-mail.',
        needCode(),
        ctx,
      );
    case 'otp-login':
      return otpEmail(
        'Your PharmaLink sign-in code',
        'finish signing in',
        'If you are not trying to sign in, change your password.',
        needCode(),
        ctx,
      );
    case 'otp-reset':
      return otpEmail(
        'Your PharmaLink password reset code',
        'reset your password',
        'If you did not ask to reset your password, ignore this e-mail. Your password has not been changed.',
        needCode(),
        ctx,
      );
    case 'otp-step_up':
      return otpEmail(
        'Your PharmaLink confirmation code',
        'confirm this action',
        'If you did not start this action, change your password.',
        needCode(),
        ctx,
      );
    case 'security-password-changed':
      return securityEmail('Your PharmaLink password was changed', 'Your PharmaLink password was changed', data.at);
    case 'security-password-reset':
      return securityEmail('Your PharmaLink password was reset', 'Your PharmaLink password was reset', data.at);
    default:
      throw new Error(`unknown identity e-mail template: ${template}`);
  }
}
