/**
 * What an SMS says (module-13 Work 15): the notification's rendered **body**, as is — already in
 * the recipient's language (am / en) and already within Works 01–10's content policy (no medicine,
 * dose, contact detail or internal id). Every template's body is a complete sentence that carries
 * the message on its own; the title only repeats it, so it is left out rather than spending SMS
 * characters (70 per segment for Amharic) on it. No id, link or extra detail is added.
 */
export function smsTextOf(rendered: { title: string; body: string }): string {
  return rendered.body.trim() || rendered.title.trim();
}
