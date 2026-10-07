/**
 * What an e-mail says (module-13 Work 16): **plain text**, subject = the notification's rendered
 * title, body = its rendered body — both already in the recipient's language (am / en) and within
 * Works 01–10's content policy (no medicine, dose, contact detail or internal id). Nothing is added:
 * no id, link, greeting or footer. The delivery architecture has no HTML template layer, so none
 * is introduced here.
 */
export function emailContentOf(rendered: { title: string; body: string }): { subject: string; text: string } {
  const subject = rendered.title.replace(/\s+/g, ' ').trim();
  const text = rendered.body.trim();
  return { subject: subject || text, text: text || subject };
}
