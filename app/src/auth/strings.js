// Every customer-facing authentication string, in one place so it can be translated. Only English is
// written so far: the Amharic copy needs a native-speaker review rather than a guess (app/README.md).
// `t(key, vars)` replaces `{name}` placeholders.

export const messages = {
  en: {
    'nav.login': 'Sign in',
    'nav.register': 'Create account',
    'nav.account': 'My account',
    'nav.logout': 'Sign out',
    'nav.accountMenu': 'Account menu',
    'nav.loadingSession': 'Checking your session',

    'field.email': 'E-mail address',
    'field.password': 'Password',
    'field.newPassword': 'New password',
    'field.confirmPassword': 'Confirm password',
    'field.confirmNewPassword': 'Confirm new password',
    'field.language': 'Preferred language',
    'field.code': 'Six-digit code',
    'field.showPassword': 'Show password',
    'field.hidePassword': 'Hide password',
    'language.en': 'English',
    'language.am': 'Amharic (አማርኛ)',

    'password.rules': 'Your password needs:',
    'password.rule.length': 'At least 8 characters',
    'password.rule.upper': 'An uppercase letter',
    'password.rule.lower': 'A lowercase letter',
    'password.rule.digit': 'A number',

    'validation.email.required': 'Enter your e-mail address.',
    'validation.email.invalid': 'Enter a valid e-mail address, like name@example.com.',
    'validation.password.required': 'Enter a password.',
    'validation.password.tooLong': 'Passwords can be at most 128 characters.',
    'validation.password.weak': 'Your password does not meet all the requirements below.',
    'validation.confirm.required': 'Enter the password again.',
    'validation.confirm.mismatch': 'The passwords do not match.',
    'validation.otp.format': 'Enter the six-digit code from the e-mail.',

    'register.title': 'Create your PharmaLink account',
    'register.subtitle': 'Sign up with your e-mail address. We will e-mail you a code to confirm it.',
    'register.submit': 'Create account',
    'register.smsNote': 'SMS verification is not available yet, so a phone number is not needed to sign up.',
    'register.haveAccount': 'Already have an account?',

    'verify.title': 'Check your e-mail',
    'verify.sentTo': 'We sent a six-digit code to {target}.',
    'verify.sentGeneric': 'Enter the six-digit code we e-mailed you.',
    'verify.noCode': 'No e-mail after a minute? Check your spam folder, or request a new code.',
    'verify.submit': 'Verify e-mail',
    'verify.resend': 'Send a new code',
    'verify.resendIn': 'You can request a new code in {seconds} s',
    'verify.resent': 'We e-mailed you a new code. Earlier codes no longer work.',
    'verify.expiry': 'Codes expire after a few minutes and work only once.',
    'verify.backToRegister': 'Use a different e-mail',
    'verify.backToLogin': 'Back to sign in',

    'login.title': 'Sign in to PharmaLink',
    'login.subtitle': 'Use the e-mail address and password you registered with.',
    'login.submit': 'Sign in',
    'login.forgot': 'Forgot your password?',
    'login.noAccount': 'New to PharmaLink?',
    'login.unverified': 'Just registered? Verify your e-mail first.',
    'login.staffNote': 'Pharmacy and admin staff sign in through the operations portal.',
    'login.expired': 'Your session ended. Please sign in again.',

    'forgot.title': 'Reset your password',
    'forgot.subtitle': 'Enter your account e-mail. If it can be reset, we will e-mail you a code.',
    'forgot.submit': 'Send reset code',
    'forgot.done': 'If an account can be reset with that address, we have e-mailed a reset code. It expires after a few minutes.',
    'forgot.haveCode': 'I have a code',

    'reset.title': 'Choose a new password',
    'reset.subtitle': 'Enter the code from the e-mail and your new password.',
    'reset.submit': 'Reset password',
    'reset.done': 'Your password was reset. Sign in with your new password.',
    'reset.needCode': 'Need a code?',

    'account.title': 'My account',
    'account.subtitle': 'Details held by PharmaLink for your account.',
    'account.email': 'E-mail',
    'account.phone': 'Phone',
    'account.status': 'Account status',
    'account.language': 'Preferred language',
    'account.emailStatus': 'E-mail',
    'account.emailVerified': 'E-mail verified',
    'account.emailVerifiedOn': 'E-mail verified on {date}',
    'account.emailUnverified': 'E-mail not verified',
    'account.phoneUnverified': 'Not verified (SMS verification is not available yet)',
    'account.notProvided': 'Not provided',
    'account.fayda': 'Fayda identity',
    'account.faydaNotConnected': 'Fayda identity verification is not yet connected.',
    'account.faydaNote': 'A verified e-mail address shows you control that inbox. It is not an identity check.',
    'account.deletionPending': 'A data-deletion request is pending for this account.',
    'account.logout': 'Sign out',
    'account.status.ACTIVE': 'Active',
    'account.status.PENDING_VERIFICATION': 'Waiting for e-mail verification',
    'account.status.SUSPENDED': 'Suspended',
    'account.status.DEACTIVATED': 'Deactivated',

    'common.or': 'or',
    'common.working': 'Please wait…',
    'common.signIn': 'Sign in',
    'common.createAccount': 'Create an account',

    'error.network': 'We could not reach PharmaLink. Check your connection and try again.',
    'error.malformed': 'PharmaLink sent an unexpected response. Please try again.',
    'error.generic': 'Something went wrong. Please try again.',
    'error.retryIn': 'Try again in {seconds} s.',
    'error.rateLimited': 'Too many attempts. Please wait a moment and try again.',
    'error.duplicate': 'An account with this e-mail already exists. Sign in, or reset your password.',
    'error.weakPassword': 'The password does not meet the security requirements.',
    'error.invalidCredentials': 'The e-mail or password is incorrect, or the account is not active yet.',
    'error.suspended': 'This account is suspended. Please contact PharmaLink support.',
    'error.locked': 'This account is temporarily locked. Please try again later.',
    'error.otpInvalid': 'That code is not correct. Check the e-mail and try again.',
    'error.otpExpired': 'That code has expired. Request a new one.',
    'error.otpAttempts': 'Too many incorrect attempts. Request a new code.',
    'error.sessionExpired': 'Your session has ended. Please sign in again.',
    'error.notCustomer': 'This is a staff account. Please use the PharmaLink operations portal.',
    'error.emailNotConfigured': 'E-mail delivery is not set up on this PharmaLink server, so no code was sent.',
    'error.emailFailed': 'We could not send the e-mail, so no code was delivered.',
    'error.smsUnavailable': 'SMS delivery is not available yet. Use your e-mail address instead.',
    'error.unavailable': 'This service is temporarily unavailable. Please try again shortly.',
  },
}

let language = 'en'

export function setLanguage(next) {
  language = messages[next] ? next : 'en'
}

export function t(key, vars) {
  const template = messages[language]?.[key] ?? messages.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}
