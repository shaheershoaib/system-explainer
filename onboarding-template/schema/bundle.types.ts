/**
 * Barrel re-export. The canonical contract now lives in ./bundle.ts (zod as the
 * single source of truth; TS types inferred from it). This file is kept so existing
 * `@schema/bundle.types` imports and the spec's "canonical schema" reference stay valid.
 */
export * from './bundle'
