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
  // Work 85: a support administrator viewed the account, read-only.
  ACCOUNT_IMPERSONATED = 'ACCOUNT_IMPERSONATED',
  // Work 86: something the complainant can see changed on their dispute.
  DISPUTE_UPDATED = 'DISPUTE_UPDATED',
  // Work 91: a moderator hid, removed or restored the recipient's review.
  REVIEW_MODERATED = 'REVIEW_MODERATED',
  ORDER_PLACED = 'ORDER_PLACED',
  ORDER_ACCEPTED = 'ORDER_ACCEPTED',
  ORDER_READY = 'ORDER_READY',
  ORDER_CANCELLED = 'ORDER_CANCELLED',
  PAYMENT_CAPTURED = 'PAYMENT_CAPTURED',
  PAYMENT_FAILED = 'PAYMENT_FAILED',
  PAYMENT_REFUNDED = 'PAYMENT_REFUNDED',
  DELIVERY_PICKED_UP = 'DELIVERY_PICKED_UP',
  DELIVERY_EN_ROUTE = 'DELIVERY_EN_ROUTE',
  DELIVERY_DELIVERED = 'DELIVERY_DELIVERED',
  DELIVERY_FAILED = 'DELIVERY_FAILED',
  DRIVER_JOB_OFFERED = 'DRIVER_JOB_OFFERED',
  DRIVER_EARNING_ACCRUED = 'DRIVER_EARNING_ACCRUED',
  DRIVER_COD_REMITTED = 'DRIVER_COD_REMITTED',
  DRIVER_COD_RECONCILED = 'DRIVER_COD_RECONCILED',
  DRIVER_COD_CORRECTION_RECORDED = 'DRIVER_COD_CORRECTION_RECORDED',
  PRESCRIPTION_APPROVED = 'PRESCRIPTION_APPROVED',
  PRESCRIPTION_REJECTED = 'PRESCRIPTION_REJECTED',
  MATCHING_FAILED = 'MATCHING_FAILED',
  PHARMACY_ACTIVATED = 'PHARMACY_ACTIVATED',
  PHARMACY_SUSPENDED = 'PHARMACY_SUSPENDED',
  WALLET_CREDITED = 'WALLET_CREDITED',
  WALLET_DEBITED = 'WALLET_DEBITED',
  DRIVER_JOB_ASSIGNED = 'DRIVER_JOB_ASSIGNED',
  MATCHING_ORDER_MATCHED = 'MATCHING_ORDER_MATCHED',
  MATCHING_REMATCH_TRIGGERED = 'MATCHING_REMATCH_TRIGGERED',
  // Work 134: prescription requests offered to nearby pharmacies.
  RX_REQUEST_NEW = 'RX_REQUEST_NEW',
  RX_REQUEST_NO_LONGER_AVAILABLE = 'RX_REQUEST_NO_LONGER_AVAILABLE',
  RX_REQUEST_AVAILABLE_AGAIN = 'RX_REQUEST_AVAILABLE_AGAIN',
  RX_REQUEST_ACCEPTED = 'RX_REQUEST_ACCEPTED',
  RX_REQUEST_REOPENED = 'RX_REQUEST_REOPENED',
  RX_REQUEST_ENDED = 'RX_REQUEST_ENDED',
  // Work 135: the pharmacy sent its medicines and price.
  RX_REQUEST_QUOTED = 'RX_REQUEST_QUOTED',
  // Work 168: doctor appointments; each of the patient and the doctor gets their own wording.
  APPOINTMENT_BOOKED = 'APPOINTMENT_BOOKED',
  APPOINTMENT_CANCELLED = 'APPOINTMENT_CANCELLED',
  APPOINTMENT_RESCHEDULED = 'APPOINTMENT_RESCHEDULED',
}

/** `pharmacy.pharmacy.suspended`'s reason when the licence on file passed its expiry date. */
export const PHARMACY_SUSPENDED_LICENSE_EXPIRED = 'LICENSE_EXPIRED';

/** `delivery.cod.reconciled`'s `outcome` when every amount agreed; anything else is a difference. */
export const COD_RECONCILED_ACCEPTED = 'ACCEPTED';

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
      am: () => ({ title: 'መለያዎ እንደገና ነቅቷል', body: 'መለያዎ እንደገና አክቲቭ ሆኗል።' }),
    },
  },
  [NotificationTemplateCode.DISPUTE_UPDATED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: `Dispute ${String(d.caseNumber)} updated`,
        body: d.change === 'MESSAGE' ? 'Support replied to your dispute.' : `Your dispute is now ${String(d.status).toLowerCase().replace(/_/g, ' ')}.`,
      }),
      am: (d) => ({
        title: `ቅሬታ ${String(d.caseNumber)} ተስተካክሏል`,
        body: d.change === 'MESSAGE' ? 'የድጋፍ ቡድኑ ለቅሬታዎ መልስ ሰጥቷል።' : 'የቅሬታዎ ሁኔታ ተቀይሯል።',
      }),
    },
  },
  [NotificationTemplateCode.REVIEW_MODERATED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Your review was moderated',
        body:
          d.move === 'restore'
            ? 'Your review is visible again.'
            : d.move === 'remove'
              ? 'Your review was removed because it breaks the review policy.'
              : 'Your review was hidden while it breaks the review policy.',
      }),
      am: (d) => ({
        title: 'ግምገማዎ በግምገማ ሂደት ውስጥ አልፏል',
        body:
          d.move === 'restore'
            ? 'ግምገማዎ እንደገና ይታያል።'
            : d.move === 'remove'
              ? 'ግምገማዎ የግምገማ ደንቡን ስለሚጥስ ተወግዷል።'
              : 'ግምገማዎ የግምገማ ደንቡን ስለሚጥስ ተደብቋል።',
      }),
    },
  },
  [NotificationTemplateCode.ACCOUNT_IMPERSONATED]: {
    category: NotificationCategory.SECURITY,
    render: {
      en: () => ({
        title: 'Support viewed your account',
        body: 'A PharmaLink support administrator is viewing your account for up to 15 minutes, read-only. Nothing can be changed. Contact support if you did not ask for help.',
      }),
      am: () => ({
        title: 'የድጋፍ ሰራተኛ መለያዎን እየተመለከተ ነው',
        body: 'የPharmaLink የድጋፍ አስተዳዳሪ መለያዎን ለ15 ደቂቃ ያህል ለንባብ ብቻ እየተመለከተ ነው። ምንም ሊቀየር አይችልም። እርዳታ ካልጠየቁ የደንበኞች አገልግሎትን ያነጋግሩ።',
      }),
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
  // Captured: the authorized amount was collected — and no more is claimed than that.
  [NotificationTemplateCode.PAYMENT_CAPTURED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Payment completed', body: 'Your payment for your order has been completed.' }),
      am: () => ({ title: 'ክፍያዎ ተጠናቋል', body: 'ለትዕዛዝዎ የፈጸሙት ክፍያ ተጠናቋል።' }),
    },
  },
  // Failed: the body states the outcome only. The sanitized provider reason travels in `data`
  // for the client to show, untranslated, as Module 07 already returns it on GET /payments/:id.
  [NotificationTemplateCode.PAYMENT_FAILED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Payment failed', body: 'Your payment could not be completed.' }),
      am: () => ({ title: 'ክፍያው አልተሳካም', body: 'ክፍያዎን ማጠናቀቅ አልተቻለም።' }),
    },
  },
  // Refunded: emitted when the refund is COMPLETED. No destination or arrival time is claimed —
  // the event carries neither.
  [NotificationTemplateCode.PAYMENT_REFUNDED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Refund completed',
        body: `A refund of ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} has been completed for your payment.`,
      }),
      am: (d) => ({
        title: 'ገንዘብዎ ተመላሽ ሆኗል',
        body: `ለክፍያዎ ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} ተመላሽ ተደርጓል።`,
      }),
    },
  },
  // The delivery status workflow (Module 08). Each says what the transition means and nothing
  // more: no ETA, driver, pharmacy name or failure cause — the events carry none that is
  // customer-facing.
  [NotificationTemplateCode.DELIVERY_PICKED_UP]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Order picked up', body: 'Your order has been picked up from the pharmacy.' }),
      am: () => ({ title: 'ትዕዛዝዎ ተወስዷል', body: 'ትዕዛዝዎ ከፋርማሲው ተወስዷል።' }),
    },
  },
  [NotificationTemplateCode.DELIVERY_EN_ROUTE]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Order on the way', body: 'Your order is on its way to you.' }),
      am: () => ({ title: 'ትዕዛዝዎ በመንገድ ላይ ነው', body: 'ትዕዛዝዎ ወደ እርስዎ በመምጣት ላይ ነው።' }),
    },
  },
  [NotificationTemplateCode.DELIVERY_DELIVERED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Order delivered', body: 'Your order has been delivered.' }),
      am: () => ({ title: 'ትዕዛዝዎ ደርሷል', body: 'ትዕዛዝዎ ደርሷል።' }),
    },
  },
  [NotificationTemplateCode.DELIVERY_FAILED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Delivery failed', body: 'We could not deliver your order.' }),
      am: () => ({ title: 'ማድረስ አልተቻለም', body: 'ትዕዛዝዎን ማድረስ አልተቻለም።' }),
    },
  },
  // ---- Driver (Module 08) ------------------------------------------------------------------
  // An offer is a request for action with a deadline. The deadline is `data.expiresAt` (ISO-8601)
  // for the client's countdown; the text does not render a clock time, which would have to pick a
  // time zone and clock convention the driver may not share.
  [NotificationTemplateCode.DRIVER_JOB_OFFERED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({
        title: 'New delivery offer',
        body: 'You have a new delivery job offer. Accept or decline it before it expires.',
      }),
      am: () => ({
        title: 'አዲስ የማድረስ ሥራ ቀርቦልዎታል',
        body: 'አዲስ የማድረስ ሥራ ቀርቦልዎታል። ጊዜው ከማለፉ በፊት ይቀበሉት ወይም ይመልሱት።',
      }),
    },
  },
  // Accrued is "owed and recorded" (EarningStatus.ACCRUED); SETTLED is Module 07's, later. The
  // text says recorded — never paid, transferred or guaranteed.
  [NotificationTemplateCode.DRIVER_EARNING_ACCRUED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Earning recorded',
        body: `An earning of ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} has been recorded for your delivery.`,
      }),
      am: (d) => ({
        title: 'ገቢ ተመዝግቧል',
        body: `ለማድረስ ሥራዎ ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} ገቢ ተመዝግቧል።`,
      }),
    },
  },
  // A remittance is cash the driver collected for the order being received by PharmaLink —
  // money passing through the driver, never the driver's income.
  [NotificationTemplateCode.DRIVER_COD_REMITTED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Cash handover confirmed',
        body: `PharmaLink has confirmed receiving the ${formatMinorUnits(Number(d.remittedAmount))} ${text(d.currency)} cash-on-delivery payment you handed over for this delivery.`,
      }),
      am: (d) => ({
        title: 'የገንዘብ ርክክብ ተረጋግጧል',
        body: `ለዚህ ማድረስ ያስረከቡትን ${formatMinorUnits(Number(d.remittedAmount))} ${text(d.currency)} የጥሬ ገንዘብ ክፍያ ፋርማሊንክ መቀበሉን አረጋግጧል።`,
      }),
    },
  },
  // The finding, nothing more: a DISCREPANCY decides no recovery, write-off or withholding.
  [NotificationTemplateCode.DRIVER_COD_RECONCILED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Cash-on-delivery reconciled',
        body:
          d.outcome === COD_RECONCILED_ACCEPTED
            ? 'The cash-on-delivery amounts for this delivery have been checked and agree.'
            : 'The cash-on-delivery amounts for this delivery have been checked and a difference was recorded.',
      }),
      am: (d) => ({
        title: 'የጥሬ ገንዘብ ክፍያ ተመሳክሯል',
        body:
          d.outcome === COD_RECONCILED_ACCEPTED
            ? 'ለዚህ ስራ የጥሬ ገንዘብ ክፍያ መጠኖች ተረጋግጠው ተስማምተዋል።'
            : 'ለዚህ ስራ የጥሬ ገንዘብ ክፍያ መጠኖች ተረጋግጠው ልዩነቱ ተመዝግቧል።',
      }),
    },
  },
  [NotificationTemplateCode.DRIVER_COD_CORRECTION_RECORDED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({
        title: 'Cash-on-delivery record corrected',
        body: 'A correction has been recorded to the cash-on-delivery record for this delivery.',
      }),
      am: () => ({
        title: 'የጥሬ ገንዘብ ክፍያ መዝገብ ተስተካክሏል',
        body: 'ለዚህ ስራ የጥሬ ገንዘብ ክፍያ መዝገብ ላይ ማስተካከያ ተደርጓል።',
      }),
    },
  },
  // ---- Prescription & matching (Module 05) ------------------------------------------------
  // Medical content never enters the text: no medicine, quantity, diagnosis, prescriber or
  // pharmacy. The text says what happened; the details are behind the customer's own routes.
  [NotificationTemplateCode.PRESCRIPTION_APPROVED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Prescription approved', body: 'Your prescription has been reviewed and approved by a pharmacist.' }),
      am: () => ({ title: 'የሐኪም ማዘዣዎ ጸድቋል', body: 'የሐኪም ማዘዣዎ በፋርማሲስት ተገምግሞ ጸድቋል።' }),
    },
  },
  // The pharmacist's reason travels in `data` (Module 05 already shows it to the customer on
  // GET /prescriptions/:id), never in the body — it is free text that may name a medicine.
  [NotificationTemplateCode.PRESCRIPTION_REJECTED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Prescription not approved', body: 'Your prescription was not approved after review.' }),
      am: () => ({ title: 'የሐኪም ማዘዣዎ አልጸደቀም', body: 'የሐኪም ማዘዣዎ ከግምገማ በኋላ አልጸደቀም።' }),
    },
  },
  [NotificationTemplateCode.MATCHING_FAILED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'No pharmacy found', body: 'We could not find a pharmacy able to fulfil your request.' }),
      am: () => ({ title: 'ፋርማሲ አልተገኘም', body: 'ጥያቄዎን ማሟላት የሚችል ፋርማሲ ማግኘት አልተቻለም።' }),
    },
  },
  // ---- Pharmacy (Module 04) ---------------------------------------------------------------
  // Administrative state changes, told to the pharmacy's owner. The text states the change only.
  [NotificationTemplateCode.PHARMACY_ACTIVATED]: {
    category: NotificationCategory.SYSTEM,
    render: {
      en: () => ({ title: 'Pharmacy activated', body: 'Your pharmacy has been activated on PharmaLink.' }),
      am: () => ({ title: 'ፋርማሲዎ ተመልሷል', body: 'ፋርማሲዎ በፋርማሊንክ ላይ ተመልሷል።' }),
    },
  },
  // `LICENSE_EXPIRED` is the reason the platform itself records (Module 04's expiry sweep) and
  // the owner can act on; any other reason is worded generically.
  [NotificationTemplateCode.PHARMACY_SUSPENDED]: {
    category: NotificationCategory.SYSTEM,
    render: {
      en: (d) => ({
        title: 'Pharmacy suspended',
        body:
          d.reason === PHARMACY_SUSPENDED_LICENSE_EXPIRED
            ? 'Your pharmacy has been suspended because its licence has expired.'
            : 'Your pharmacy has been suspended.',
      }),
      am: (d) => ({
        title: 'ፋርማሲዎ ታግዷል',
        body: d.reason === PHARMACY_SUSPENDED_LICENSE_EXPIRED ? 'የፈቃዱ ጊዜ ስላለፈ ፋርማሲዎ ታግዷል።' : 'ፋርማሲዎ ታግዷል።',
      }),
    },
  },
  // ---- Wallet (Module 07) -----------------------------------------------------------------
  // Money entering or leaving the customer's PharmaLink wallet — an internal stored balance. Not a
  // bank transfer, not income, not a completed external payment; no balance is stated (the event
  // carries none, by design: a balance is derived at read time).
  [NotificationTemplateCode.WALLET_CREDITED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Wallet credited',
        body: `Your PharmaLink wallet has been credited with ${formatMinorUnits(Number(d.amount))} ${text(d.currency)}.`,
      }),
      am: (d) => ({
        title: 'ወደ ዋሌትዎ ገንዘብ ገብቷል',
        body: `ወደ ፋርማሊንክ ዋሌትዎ ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} ገብቷል።`,
      }),
    },
  },
  [NotificationTemplateCode.WALLET_DEBITED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Wallet debited',
        body: `${formatMinorUnits(Number(d.amount))} ${text(d.currency)} has been deducted from your PharmaLink wallet.`,
      }),
      am: (d) => ({
        title: 'ከዋሌትዎ ገንዘብ ተቀንሷል',
        body: `ከፋርማሊንክ ዋሌትዎ ${formatMinorUnits(Number(d.amount))} ${text(d.currency)} ተቀንሷል።`,
      }),
    },
  },
  // Work 09 (driver, Module 08 event): the offer the driver accepted is now their job. States the assignment only —
  // no pickup, ETA, earning or COD claim; not a repeat of the offer, which asked for a decision.
  [NotificationTemplateCode.DRIVER_JOB_ASSIGNED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Delivery job assigned', body: 'This delivery job is now assigned to you.' }),
      am: () => ({ title: 'የማድረስ ሥራ ተመድቦልዎታል', body: 'ይህ የማድረስ ሥራ አሁን ለእርስዎ ተመድቧል።' }),
    },
  },
  // ---- Matching outcomes (Module 05), Work 10 -------------------------------------------------
  // `matching.order_matched` is written when a pharmacy is selected for the request (by the
  // customer, or inside checkout) and its stock reserved. It says a pharmacy was found — not that
  // the order is accepted, ready, paid or dispensed — and never which pharmacy.
  [NotificationTemplateCode.MATCHING_ORDER_MATCHED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Pharmacy found', body: 'We found a pharmacy that can fulfil your request.' }),
      am: () => ({ title: 'ፋርማሲ ተገኝቷል', body: 'ጥያቄዎን ማሟላት የሚችል ፋርማሲ ተገኝቷል።' }),
    },
  },
  // `matching.rematch_triggered` is written only once a rematch has *succeeded*: the previous
  // pharmacy is excluded and the request is MATCHED to another, with stock reserved (a rematch that
  // finds none emits `matching.match_failed` instead). So the text says it moved — never which
  // pharmacy, why, or that the customer must act.
  [NotificationTemplateCode.MATCHING_REMATCH_TRIGGERED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Moved to another pharmacy', body: 'Your request has been moved to another pharmacy.' }),
      am: () => ({ title: 'ወደ ሌላ ፋርማሲ ተዛውሯል', body: 'ጥያቄዎ ወደ ሌላ ፋርማሲ ተዛውሯል።' }),
    },
  },
  // ---- Prescription requests (Work 134) ---------------------------------------------------
  // Amharic reviewed by the owner, a native speaker, on 2026-11-18 (Work 142).
  [NotificationTemplateCode.RX_REQUEST_NEW]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'New prescription request', body: 'A customer nearby sent a prescription. Review it and accept it if your pharmacy can fill it.' }),
      am: () => ({ title: 'አዲስ የሐኪም ማዘዣ ጥያቄ', body: 'በአቅራቢያዎ ያለ ደንበኛ የሐኪም ማዘዣ ልኳል። ይመልከቱት፤ ፋርማሲዎ ማቅረብ ከቻለ ይቀበሉት።' }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_NO_LONGER_AVAILABLE]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Prescription request no longer available',
        body:
          d.reason === 'accepted-by-another-pharmacy'
            ? 'Another pharmacy accepted this prescription request.'
            : d.reason === 'cancelled-by-customer'
              ? 'The customer cancelled this prescription request.'
              : d.reason === 'quote-declined-by-customer'
                ? 'The customer declined your quote for this prescription request.'
                : d.reason === 'quote-not-answered-in-time'
                  ? 'The customer did not answer your quote in time; the request has ended.'
                  : 'This prescription request has ended.',
      }),
      am: (d) => ({
        title: 'የሐኪም ማዘዣ ጥያቄው ከአሁን በኋላ አይገኝም',
        body:
          d.reason === 'accepted-by-another-pharmacy'
            ? 'ሌላ ፋርማሲ ይህን የሐኪም ማዘዣ ጥያቄ ተቀብሏል።'
            : d.reason === 'cancelled-by-customer'
              ? 'ደንበኛው ይህን የሐኪም ማዘዣ ጥያቄ ሰርዟል።'
              : d.reason === 'quote-declined-by-customer'
                ? 'ደንበኛው ለዚህ የሐኪም ማዘዣ ጥያቄ ያቀረቡትን ዋጋ አልተቀበለም።'
                : d.reason === 'quote-not-answered-in-time'
                  ? 'ደንበኛው በጊዜው ለዋጋዎ መልስ አልሰጠም፤ ጥያቄው አብቅቷል።'
                  : 'ይህ የሐኪም ማዘዣ ጥያቄ አብቅቷል።',
      }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_AVAILABLE_AGAIN]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Prescription request available again', body: 'A prescription request you were offered is open again. Accept it if your pharmacy can fill it.' }),
      am: () => ({ title: 'የሐኪም ማዘዣ ጥያቄው እንደገና ይገኛል', body: 'የቀረበልዎ የሐኪም ማዘዣ ጥያቄ እንደገና ክፍት ሆኗል። ፋርማሲዎ ማቅረብ ከቻለ ይቀበሉት።' }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_ACCEPTED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'A pharmacy accepted your request',
        body: `${d.pharmacyName ? d.pharmacyName : 'A pharmacy'} is checking your prescription and will send you the medicines and price.`,
      }),
      am: (d) => ({
        title: 'ፋርማሲ ጥያቄዎን ተቀብሏል',
        body: `${d.pharmacyName ? d.pharmacyName : 'አንድ ፋርማሲ'} የሐኪም ማዘዣዎን እያየ ነው፤ መድኃኒቶቹንና ዋጋውን ይልክልዎታል።`,
      }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_REOPENED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: () => ({ title: 'Looking for another pharmacy', body: 'The pharmacy could not fill your prescription. We are offering it to other pharmacies nearby.' }),
      am: () => ({ title: 'ሌላ ፋርማሲ እየተፈለገ ነው', body: 'ፋርማሲው የሐኪም ማዘዣዎን ማቅረብ አልቻለም። በአቅራቢያ ላሉ ሌሎች ፋርማሲዎች እየቀረበ ነው።' }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_ENDED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'No pharmacy could take your request',
        body:
          d.status === 'EXPIRED'
            ? 'No pharmacy accepted your prescription in time. You can send it again.'
            : d.status === 'QUOTE_EXPIRED'
              ? 'The pharmacy’s offer was not confirmed in time, so your request has ended. You can send it again.'
              : 'No pharmacy nearby can fill your prescription right now. You can send it again later.',
      }),
      am: (d) => ({
        title: 'ጥያቄዎን የተቀበለ ፋርማሲ የለም',
        body:
          d.status === 'EXPIRED'
            ? 'በጊዜው የሐኪም ማዘዣዎን የተቀበለ ፋርማሲ የለም። እንደገና መላክ ይችላሉ።'
            : d.status === 'QUOTE_EXPIRED'
              ? 'የፋርማሲው ዋጋ በጊዜው ስላልተረጋገጠ ጥያቄዎ አብቅቷል። እንደገና መላክ ይችላሉ።'
              : 'አሁን በአቅራቢያዎ የሐኪም ማዘዣዎን ማቅረብ የሚችል ፋርማሲ የለም። በኋላ እንደገና መላክ ይችላሉ።',
      }),
    },
  },
  [NotificationTemplateCode.APPOINTMENT_BOOKED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) =>
        d.role === 'DOCTOR'
          ? { title: 'New appointment', body: `A patient booked ${String(d.startsAtLabel)}${d.appointmentType === 'TELEMEDICINE' ? ' (video)' : ''}.` }
          : { title: 'Appointment confirmed', body: `${String(d.doctorName)}, ${String(d.startsAtLabel)}${d.appointmentType === 'TELEMEDICINE' ? ' by video' : ''}. The fee is paid at the visit.` },
      am: (d) =>
        d.role === 'DOCTOR'
          ? { title: 'አዲስ ቀጠሮ', body: `አንድ ታካሚ ${String(d.startsAtLabel)} ቀጠሮ ይዟል${d.appointmentType === 'TELEMEDICINE' ? ' (በቪዲዮ)' : ''}።` }
          : { title: 'ቀጠሮዎ ተረጋግጧል', body: `${String(d.doctorName)}፣ ${String(d.startsAtLabel)}${d.appointmentType === 'TELEMEDICINE' ? ' በቪዲዮ' : ''}። ክፍያው በጉብኝቱ ጊዜ ይከፈላል።` },
    },
  },
  [NotificationTemplateCode.APPOINTMENT_CANCELLED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Appointment cancelled',
        body:
          d.role === 'DOCTOR'
            ? `${d.by === 'DOCTOR' ? 'You cancelled' : 'The patient cancelled'} the appointment on ${String(d.startsAtLabel)}.`
            : `${d.by === 'DOCTOR' ? `${String(d.doctorName)} cancelled` : 'You cancelled'} your appointment on ${String(d.startsAtLabel)}.${d.by === 'DOCTOR' ? ' Please book another time.' : ''}`,
      }),
      am: (d) => ({
        title: 'ቀጠሮው ተሰርዟል',
        body:
          d.role === 'DOCTOR'
            ? `የ${String(d.startsAtLabel)} ቀጠሮ ${d.by === 'DOCTOR' ? 'በእርስዎ' : 'በታካሚው'} ተሰርዟል።`
            : `የ${String(d.startsAtLabel)} ቀጠሮዎ ${d.by === 'DOCTOR' ? `በ${String(d.doctorName)}` : 'በእርስዎ'} ተሰርዟል።${d.by === 'DOCTOR' ? ' እባክዎ ሌላ ጊዜ ይያዙ።' : ''}`,
      }),
    },
  },
  [NotificationTemplateCode.APPOINTMENT_RESCHEDULED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Appointment moved',
        body: `${d.role === 'DOCTOR' ? 'A patient moved their appointment' : `Your appointment with ${String(d.doctorName)} is moved`} from ${String(d.previousLabel)} to ${String(d.startsAtLabel)}.`,
      }),
      am: (d) => ({
        title: 'ቀጠሮው ተዛውሯል',
        body: `${d.role === 'DOCTOR' ? 'አንድ ታካሚ ቀጠሮውን' : `ከ${String(d.doctorName)} ጋር ያለዎ ቀጠሮ`} ከ${String(d.previousLabel)} ወደ ${String(d.startsAtLabel)} ተዛውሯል።`,
      }),
    },
  },
  [NotificationTemplateCode.RX_REQUEST_QUOTED]: {
    category: NotificationCategory.TRANSACTIONAL,
    render: {
      en: (d) => ({
        title: 'Your medicines and price are ready',
        body: `The pharmacy checked your prescription. ${typeof d.grandTotal === 'number' ? `Total ${formatMinorUnits(d.grandTotal)} ${d.currency ?? 'ETB'}. ` : ''}Confirm it to place your order.`,
      }),
      am: (d) => ({
        title: 'መድኃኒቶችዎና ዋጋው ዝግጁ ናቸው',
        body: `ፋርማሲው የሐኪም ማዘዣዎን አይቷል። ${typeof d.grandTotal === 'number' ? `ጠቅላላ ${formatMinorUnits(d.grandTotal)} ${d.currency ?? 'ETB'}። ` : ''}ትዕዛዝዎን ለማስገባት ያረጋግጡ።`,
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
