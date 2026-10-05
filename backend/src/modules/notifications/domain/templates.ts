import { DEFAULT_NOTIFICATION_LANGUAGE, NotificationCategory, NotificationLanguage } from './enums';

/**
 * The code-owned template catalogue (module-13 Work 01). One entry per notification the platform
 * sends, each with an English and an Amharic rendering. Pure functions over the notification's
 * own `data`, so a rendering can be re-derived and tested without a database.
 *
 * Deliberately not the `notification_templates` table: that table models versioned,
 * admin-managed templates per channel, and nothing manages them yet. When template CRUD arrives,
 * these entries are the seed it starts from.
 */
export enum NotificationTemplateCode {
  PROVIDER_VERIFICATION_APPROVED = 'PROVIDER_VERIFICATION_APPROVED',
  PROVIDER_VERIFICATION_REJECTED = 'PROVIDER_VERIFICATION_REJECTED',
  PROVIDER_LICENSE_EXPIRED = 'PROVIDER_LICENSE_EXPIRED',
  ACCOUNT_SUSPENDED = 'ACCOUNT_SUSPENDED',
  ACCOUNT_REACTIVATED = 'ACCOUNT_REACTIVATED',
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_ACCEPTED = 'ORDER_ACCEPTED',
  ORDER_READY = 'ORDER_READY',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
}

/**
 * The one `order.cancelled` reason the platform itself writes (Module 06's decline path, when no
 * pharmacy is left to re-route to). Any other reason is the customer's own words from their
 * cancel request, which the notification does not echo back to them.
 */
export const NO_PHARMACY_MATCH_REASON = 'NO_PHARMACY_MATCH';

/** The structured, UI-facing fields a notification carries. Never a raw event payload. */
export type NotificationData = Record<string, string | number | null>;

export interface RenderedText {
  title: string;
  body: string;
}

interface TemplateEntry {
  category: NotificationCategory;
  render: Record<NotificationLanguage, (data: NotificationData) => RenderedText>;
}

/** ETB minor units → "1,250.00". Money is integer minor units platform-wide (shared conventions §11). */
export function formatMinorUnits(minor: number): string {
  return (minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const text = (value: string | number | null | undefined): string => (value === null || value === undefined ? '' : String(value));

export const NOTIFICATION_TEMPLATES: Record<NotificationTemplateCode, TemplateEntry> = {
  [NotificationTemplateCode.PROVIDER_VERIFICATION_APPROVED]: {
    category: NotificationCategory.SYSTEM,
    render: {
      en: () => ({ title: 'Verification approved', body: 'Your verification request has been approved.' }),
      am: () => ({ title: 'ማረጋገጫዎ ጸድቋል', body: 'የማረጋገጫ ጥያቄዎ ጸድቋል።' }),
    },
  },
  [NotificationTemplateCode.PROVIDER_VERIFICATION_REJECTED]: {
    category: NotificationCategory.SYSTEM,
    render: {
      en: (d) => ({
        title: 'Verification not approved',
        body: d.reason
          ? `Your verification request was not approved. Reason: ${text(d.reason)}`
          : 'Your verification request was not approved.',
      }),
      am: (d) => ({
        title: 'ማረጋገጫዎ አልጸደቀም',
        body: d.reason ? `የማረጋገጫ ጥያቄዎ አልጸደቀም። ምክንያት፦ ${text(d.reason)}` : 'የማረጋገጫ ጥያቄዎ አልጸደቀም።',
      }),
    },
  },
  [NotificationTemplateCode.PROVIDER_LICENSE_EXPIRED]: {
    category: NotificationCategory.SYSTEM,
    render: {
      en: () => ({
        title: 'Licence expired',
        body: 'Your licence has expired. Submit a renewed licence to restore your account.',
      }),
      am: () => ({ title: 'ፈቃድዎ ጊዜው አልፏል', body: 'ፈቃድዎ ጊዜው አልፏል። መለያዎን ለማስመለስ የታደሰ ፈቃድ ያስገቡ።' }),
    },
  },
  [NotificationTemplateCode.ACCOUNT_SUSPENDED]: {
    category: NotificationCategory.SECURITY,
    render: {
      en: () => ({
        title: 'Account suspended',
        body: 'Your account has been suspended. Contact support if you think this is a mistake.',
      }),
      am: () => ({
        title: 'መለያዎ ታግዷል',
        body: 'መለያዎ ታግዷል። ይህ ስህተት ነው ብለው ካሰቡ የደንበኞች አገልግሎትን ያነጋግሩ።',
      }),
    },
  },
  [NotificationTemplateCode.ACCOUNT_REACTIVATED]: {
    category: NotificationCategory.SECURITY,
    render: {
      en: () => ({ title: 'Account reactivated', body: 'Your account is active again.' }),
      am: () => ({ title: 'መለያዎ እንደገና ነቅቷል', body: 'መለያዎ እንደገና ንቁ ሆኗል።' }),
    },
  },
  [NotificationTemplateCode.ORDER_PLACED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Order placed',
        body: `We have received your order. Total: ${formatMinorUnits(Number(d.grandTotal))} ${text(d.currency)}.`,
      }),
      am: (d) => ({
        title: 'ትዕዛዝዎ ደርሶናል',
        body: `ትዕዛዝዎን ተቀብለናል። ጠቅላላ ድምር፦ ${formatMinorUnits(Number(d.grandTotal))} ${text(d.currency)}።`,
      }),
    },
  },
  [NotificationTemplateCode.ORDER_ACCEPTED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Order accepted', body: 'The pharmacy has accepted your order and is preparing it.' }),
      am: () => ({ title: 'ትዕዛዝዎ ተቀባይነት አግኝቷል', body: 'ፋርማሲው ትዕዛዝዎን ተቀብሎ እያዘጋጀው ነው።' }),
    },
  },
  [NotificationTemplateCode.ORDER_READY]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Order ready', body: 'Your order is packed and ready to be sent out.' }),
      am: () => ({ title: 'ትዕዛዝዎ ዝግጁ ነው', body: 'ትዕዛዝዎ ታሽጎ ለመላክ ዝግጁ ነው።' }),
    },
  },
  [NotificationTemplateCode.ORDER_CANCELLED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Order cancelled',
        body:
          d.reason === NO_PHARMACY_MATCH_REASON
            ? 'No pharmacy could fulfil your order, so it has been cancelled.'
            : 'Your order has been cancelled.',
      }),
      am: (d) => ({
        title: 'ትዕዛዝዎ ተሰርዟል',
        body:
          d.reason === NO_PHARMACY_MATCH_REASON
            ? 'ትዕዛዝዎን ማሟላት የሚችል ፋርማሲ ስላልተገኘ ትዕዛዝዎ ተሰርዟል።'
            : 'ትዕዛዝዎ ተሰርዟል።',
      }),
    },
  },
};

/** A supported language, or the default when the value is missing or unrecognised. */
export function resolveLanguage(language: string | null | undefined): NotificationLanguage {
  return language === NotificationLanguage.am || language === NotificationLanguage.en
    ? language
    : DEFAULT_NOTIFICATION_LANGUAGE;
}

export function renderNotification(
  code: NotificationTemplateCode,
  language: string | null | undefined,
  data: NotificationData,
): RenderedText & { language: NotificationLanguage } {
  const resolved = resolveLanguage(language);
  return { language: resolved, ...NOTIFICATION_TEMPLATES[code].render[resolved](data) };
}
