// Every customer-facing authentication string, in one place so it can be translated. English and
// Amharic; the Amharic was reviewed by a native speaker (Work 131). A key with no Amharic shows
// its English. `t(key, vars)` replaces `{name}` placeholders. Work 143 adds the pages' text from
// ../i18n/pages.js.
import { useSyncExternalStore } from 'react'
import { pageMessages } from '../i18n/pages'

const authMessages = {
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
    'account.languageSave': 'Save',
    'account.languageSaved': 'Language saved.',
    'account.languageFailed': 'The language could not be saved. Please try again.',
    'account.languageNote': 'Sign-in, your account and notifications use this language. The other screens are in English for now.',
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
    'error.notCustomer': 'This is a PharmaLink staff account. Sign in to the operations portal instead; the app is for customers.',
    'error.driverAccount': 'This is a driver account. Sign in to the PharmaLink driver app instead; this app is for customers.',
    // Work 126: the server says NOT_CONFIGURED both when it has no e-mail provider and when the provider
    // refuses this address (a test sender only delivers to its own account), so the text fits both.
    'error.emailNotConfigured': 'We could not send a code to this e-mail address. Check that it is right; if it is, PharmaLink cannot e-mail it yet, so please contact PharmaLink support.',
    'error.emailFailed': 'We could not send the e-mail, so no code was delivered.',
    'error.smsUnavailable': 'SMS delivery is not available yet. Use your e-mail address instead.',
    'error.unavailable': 'This service is temporarily unavailable. Please try again shortly.',
  },
  // Work 131: reviewed by the owner, a native speaker, on 2026-11-16. A key missing here shows its English.
  am: {
    'nav.login': 'ግባ',
    'nav.register': 'መለያ ይፍጠሩ',
    'nav.account': 'የእኔ መለያ',
    'nav.logout': 'ውጣ',
    'nav.accountMenu': 'የመለያ ቦታ',
    'nav.loadingSession': 'ክፍለ ጊዜዎን በማረጋገጥ ላይ',
    'field.email': 'የኢሜይል አድራሻ',
    'field.password': 'የይለፍ ቃል',
    'field.newPassword': 'አዲስ የይለፍ ቃል',
    'field.confirmPassword': 'የይለፍ ቃሉን ያረጋግጡ',
    'field.confirmNewPassword': 'አዲሱን የይለፍ ቃል ያረጋግጡ',
    'field.language': 'የሚመርጡት ቋንቋ',
    'field.code': 'ባለ ስድስት አሃዝ ኮድ',
    'field.showPassword': 'የይለፍ ቃሉን አሳይ',
    'field.hidePassword': 'የይለፍ ቃሉን ደብቅ',
    'language.en': 'እንግሊዝኛ (English)',
    'language.am': 'አማርኛ',
    'password.rules': 'የይለፍ ቃልዎ የሚከተሉትን ማሟላት አለበት፦',
    'password.rule.length': 'ቢያንስ 8 ምልክቶች',
    'password.rule.upper': 'አንድ ትልቅ የእንግሊዝኛ ፊደል (A–Z)',
    'password.rule.lower': 'አንድ ትንሽ የእንግሊዝኛ ፊደል (a–z)',
    'password.rule.digit': 'አንድ ቁጥር',
    'validation.email.required': 'የኢሜይል አድራሻዎን ያስገቡ።',
    'validation.email.invalid': 'ትክክለኛ የኢሜይል አድራሻ ያስገቡ፤ ለምሳሌ name@example.com።',
    'validation.password.required': 'የይለፍ ቃል ያስገቡ።',
    'validation.password.tooLong': 'የይለፍ ቃል ቢበዛ 128 ፊደላቶች ሊሆን ይችላል።',
    'validation.password.weak': 'የይለፍ ቃልዎ ከታች ያሉትን መስፈርቶች በሙሉ አያሟላም።',
    'validation.confirm.required': 'የይለፍ ቃሉን እንደገና ያስገቡ።',
    'validation.confirm.mismatch': 'የይለፍ ቃሎቹ አይመሳሰሉም።',
    'validation.otp.format': 'ከኢሜይሉ የደረሰዎትን ባለ ስድስት አሃዝ ኮድ ያስገቡ።',
    'register.title': 'የፋርማሊንክ መለያዎን ይፍጠሩ',
    'register.subtitle': 'በኢሜይል አድራሻዎ ይመዝገቡ። ለማረጋገጥ ኮድ በኢሜይል እንልክልዎታለን።',
    'register.submit': 'መለያ ፍጠር',
    'register.smsNote': 'የኤስኤምኤስ ማረጋገጫ ገና ስለሌለ ለመመዝገብ ስልክ ቁጥር አያስፈልግም።',
    'register.haveAccount': 'መለያ አለዎት?',
    'verify.title': 'ኢሜይልዎን ይመልከቱ',
    'verify.sentTo': 'ወደ {target} ባለ ስድስት አሃዝ ኮድ ልከናል።',
    'verify.sentGeneric': 'በኢሜይል የላክንልዎትን ባለ ስድስት አሃዝ ኮድ ያስገቡ።',
    'verify.noCode': 'ከአንድ ደቂቃ በኋላም ኢሜይል ካልደረሰዎት የአይፈለጌ መልዕክት (spam) ማህደርዎን ይመልከቱ ወይም አዲስ ኮድ ይጠይቁ።',
    'verify.submit': 'ኢሜይሉን አረጋግጥ',
    'verify.resend': 'አዲስ ኮድ ላክ',
    'verify.resendIn': 'በ{seconds} ሰከንድ ውስጥ አዲስ ኮድ መጠየቅ ይችላሉ',
    'verify.resent': 'አዲስ ኮድ በኢሜይል ልከንልዎታል። ቀደም ያሉት ኮዶች ከአሁን በኋላ አይሰሩም።',
    'verify.expiry': 'ኮዶች ከጥቂት ደቂቃዎች በኋላ ጊዜያቸው ያልፋል፤ የሚያገለግሉትም አንድ ጊዜ ብቻ ነው።',
    'verify.backToRegister': 'ሌላ ኢሜይል ተጠቀም',
    'verify.backToLogin': 'ወደ መግቢያ ተመለስ',
    'login.title': 'ወደ ፋርማሊንክ ይግቡ',
    'login.subtitle': 'የተመዘገቡበትን የኢሜይል አድራሻና የይለፍ ቃል ይጠቀሙ።',
    'login.submit': 'ግባ',
    'login.forgot': 'የይለፍ ቃልዎን ረሱ?',
    'login.noAccount': 'ለፋርማሊንክ አዲስ ነዎት?',
    'login.unverified': 'አሁን ተመዘገቡ? መጀመሪያ ኢሜይልዎን ያረጋግጡ።',
    'login.staffNote': 'የፋርማሲና የአስተዳደር ሰራተኞች የሚገቡት በኦፕሬሽን ፖርታሉ በኩል ነው።',
    'login.expired': 'ክፍለ ጊዜዎ አብቅቷል። እባክዎ እንደገና ይግቡ።',
    'forgot.title': 'የይለፍ ቃልዎን ይቀይሩ',
    'forgot.subtitle': 'የመለያዎን ኢሜይል ያስገቡ። መቀየር የሚቻል ከሆነ ኮድ በኢሜይል እንልክልዎታለን።',
    'forgot.submit': 'የመቀየሪያ ኮድ ላክ',
    'forgot.done': 'በዚህ አድራሻ የሚቀየር መለያ ካለ የመቀየሪያ ኮድ በኢሜይል ልከናል። ኮዱ ከጥቂት ደቂቃዎች በኋላ ጊዜው ያልፋል።',
    'forgot.haveCode': 'ኮድ አለኝ',
    'reset.title': 'አዲስ የይለፍ ቃል ይምረጡ',
    'reset.subtitle': 'ከኢሜይሉ የደረሰዎትን ኮድና አዲሱን የይለፍ ቃልዎን ያስገቡ።',
    'reset.submit': 'የይለፍ ቃል ቀይር',
    'reset.done': 'የይለፍ ቃልዎ ተቀይሯል። በአዲሱ የይለፍ ቃልዎ ይግቡ።',
    'reset.needCode': 'ኮድ ያስፈልግዎታል?',
    'account.title': 'የእኔ መለያ',
    'account.subtitle': 'ፋርማሊንክ ስለ መለያዎ የያዛቸው መረጃዎች።',
    'account.email': 'ኢሜይል',
    'account.phone': 'ስልክ',
    'account.status': 'የመለያ ሁኔታ',
    'account.language': 'የሚመርጡት ቋንቋ',
    'account.emailStatus': 'ኢሜይል',
    'account.emailVerified': 'ኢሜይሉ ተረጋግጧል',
    'account.emailVerifiedOn': 'ኢሜይሉ በ{date} ተረጋግጧል',
    'account.emailUnverified': 'ኢሜይሉ አልተረጋገጠም',
    'account.phoneUnverified': 'አልተረጋገጠም (የኤስኤምኤስ ማረጋገጫ ገና አልተጀመረም)',
    'account.notProvided': 'አልተሰጠም',
    'account.fayda': 'የፋይዳ መታወቂያ',
    'account.faydaNotConnected': 'የፋይዳ መታወቂያ ማረጋገጫ ገና አልተገናኘም።',
    'account.faydaNote': 'የተረጋገጠ ኢሜይል ያንን የኢሜይል ሳጥን እርስዎ እንደሚቆጣጠሩ ያሳያል። የማንነት ማረጋገጫ አይደለም።',
    'account.deletionPending': 'ለዚህ መለያ የመረጃ ስረዛ ጥያቄ በሂደት ላይ ነው።',
    'account.logout': 'ውጣ',
    'account.status.ACTIVE': 'ንቁ',
    'account.status.PENDING_VERIFICATION': 'የኢሜይል ማረጋገጫን በመጠበቅ ላይ',
    'account.status.SUSPENDED': 'ታግዷል',
    'account.status.DEACTIVATED': 'ተሰናክሏል',
    'common.or': 'ወይም',
    'common.working': 'እባክዎ ይጠብቁ…',
    'common.signIn': 'ግባ',
    'common.createAccount': 'መለያ ይፍጠሩ',
    'error.network': 'ፋርማሊንክን ማግኘት አልቻልንም። የኢንተርኔት ግንኙነትዎን አረጋግጠው እንደገና ይሞክሩ።',
    'error.malformed': 'ፋርማሊንክ ያልተጠበቀ ምላሽ ልኳል። እባክዎ እንደገና ይሞክሩ።',
    'error.generic': 'የሆነ ችግር ተፈጥሯል። እባክዎ እንደገና ይሞክሩ።',
    'error.retryIn': 'በ{seconds} ሰከንድ ውስጥ እንደገና ይሞክሩ።',
    'error.rateLimited': 'በጣም ብዙ ሙከራዎች ተደርገዋል። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።',
    'error.duplicate': 'በዚህ ኢሜይል የተከፈተ መለያ አለ። ይግቡ ወይም የይለፍ ቃልዎን ይቀይሩ።',
    'error.weakPassword': 'የይለፍ ቃሉ የደህንነት መስፈርቶቹን አያሟላም።',
    'error.invalidCredentials': 'ኢሜይሉ ወይም የይለፍ ቃሉ ትክክል አይደለም፣ ወይም መለያው ገና አልነቃም።',
    'error.suspended': 'ይህ መለያ ታግዷል። እባክዎ የፋርማሊንክ ድጋፍን ያነጋግሩ።',
    'error.locked': 'ይህ መለያ ለጊዜው ተቆልፏል። እባክዎ ቆይተው እንደገና ይሞክሩ።',
    'error.otpInvalid': 'ያ ኮድ ትክክል አይደለም። ኢሜይሉን አይተው እንደገና ይሞክሩ።',
    'error.otpExpired': 'የዚያ ኮድ ጊዜ አልፏል። አዲስ ኮድ ይጠይቁ።',
    'error.otpAttempts': 'በጣም ብዙ የተሳሳቱ ሙከራዎች ተደርገዋል። አዲስ ኮድ ይጠይቁ።',
    'error.sessionExpired': 'ክፍለ ጊዜዎ አብቅቷል። እባክዎ እንደገና ይግቡ።',
    'error.notCustomer': 'ይህ የፋርማሊንክ ሰራተኛ መለያ ነው። በምትኩ በኦፕሬሽን ፖርታሉ ይግቡ፤ ይህ መተግበሪያ ለደንበኞች ነው።',
    'error.driverAccount': 'ይህ የአሽከርካሪ መለያ ነው። በምትኩ በፋርማሊንክ የአሽከርካሪ መተግበሪያ ይግቡ፤ ይህ መተግበሪያ ለደንበኞች ነው።',
    'error.emailNotConfigured': 'ወደዚህ ኢሜይል አድራሻ ኮድ መላክ አልቻልንም። አድራሻው ትክክል መሆኑን ያረጋግጡ፤ ትክክል ከሆነ ፋርማሊንክ ገና ወደዚህ አድራሻ ኢሜይል መላክ ስለማይችል እባክዎ የፋርማሊንክ ድጋፍን ያነጋግሩ።',
    'error.emailFailed': 'ኢሜይሉን መላክ ስላልቻልን ምንም ኮድ አልተላከም።',
    'error.smsUnavailable': 'በኤስኤምኤስ መላክ ገና አልተጀመረም። በምትኩ የኢሜይል አድራሻዎን ይጠቀሙ።',
    'error.unavailable': 'ይህ አገልግሎት ለጊዜው አይገኝም። እባክዎ ትንሽ ቆይተው እንደገና ይሞክሩ።',
  },
}

export const messages = {
  en: { ...authMessages.en, ...pageMessages.en },
  am: { ...authMessages.am, ...pageMessages.am },
}

const listeners = new Set()

const LANGUAGE_KEY = 'pharmalink.customer.language'

function storedLanguage() {
  try {
    return globalThis.localStorage?.getItem(LANGUAGE_KEY) ?? null
  } catch {
    return null
  }
}

let language = messages[storedLanguage()] ? storedLanguage() : 'en'

export function getLanguage() {
  return language
}

/**
 * Work 131: the language the screens use. It follows the signed-in customer's preferred language
 * and is remembered on this device, so the sign-in screens open in it next time too.
 */
export function setLanguage(next) {
  language = messages[next] ? next : 'en'
  try {
    globalThis.localStorage?.setItem(LANGUAGE_KEY, language)
  } catch {
    // Storage can be unavailable (private mode); the choice then lasts for this visit.
  }
  if (globalThis.document?.documentElement) globalThis.document.documentElement.lang = language
  for (const listener of listeners) listener()
}

function subscribe(listener) {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** Work 143: the current language; a component that uses it draws again when the language changes. */
export function useLanguage() {
  return useSyncExternalStore(subscribe, getLanguage, getLanguage)
}

export function t(key, vars) {
  const template = messages[language]?.[key] ?? messages.en[key] ?? key
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match))
}
