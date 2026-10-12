/**
 * The audit identity of a product status change: the action and resource type
 * `ChangeProductStatusCommand` writes, and the catalogue review history (module-16 Work 33) reads back.
 * One definition, so the writer and the reader cannot drift apart.
 */
export const PRODUCT_STATUS_CHANGED_ACTION = 'PRODUCT_STATUS_CHANGED';
export const PRODUCT_AUDIT_RESOURCE_TYPE = 'Product';
