/**
 * The single place this module decides "does this catalog product need a prescription?"
 * (module-05 §12's `PrescriptionGate` matrix: **"OTC always allowed"**).
 *
 * Replaces an inline `Boolean(product.rxClassification)`, which was `true` for the *string*
 * `'OTC'` — and since `rxClassification` is mandatory for every `MEDICINE` (module-03 §3.6
 * invariant 1, `ClassificationPolicy.assertValidClassification`), that made **every OTC medicine
 * require a prescription**, contradicting the spec's own allow/block matrix.
 *
 * Own copy per ADR-002 — Module 06 keeps an identical rule in its own domain layer rather than
 * importing this one, exactly as each module keeps its own `ICatalogPort`/`CatalogProductView`
 * copy and its own `concurrentModification()` error. The two copies must agree; both are unit
 * tested against the same three cases.
 *
 * The comparison is against the string `'RX'` rather than Module 03's `RxClassification` enum
 * because this module's `CatalogProductView.rxClassification` is deliberately a plain
 * `string | null` (ADR-002: no cross-context type imports). No new classification value is
 * introduced — `RX` and `OTC` remain the only two the catalog enum defines.
 */
export const RX_CLASSIFICATION_REQUIRING_PRESCRIPTION = 'RX';

export const RxClassificationPolicy = {
  /**
   * `RX` -> requires a prescription. `OTC` -> does not. `null`/`undefined` (a
   * `HEALTH_PRODUCT`, which must not carry a classification at all, or a product the catalog
   * read missed) -> does not, preserving the previous non-Rx behaviour for unclassified items.
   */
  requiresPrescription(rxClassification: string | null | undefined): boolean {
    return rxClassification === RX_CLASSIFICATION_REQUIRING_PRESCRIPTION;
  },
};
