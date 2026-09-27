import { createGenericSelectorAdapter, type GenericSelectorConfig } from "./adapters/generic-selector.js";
import type { SourceAdapter, SourceConfig } from "./core/types.js";

/** Adapter khusus per situs (ditulis dengan kode) didaftarkan di sini. */
const custom: Record<string, (cfg: Record<string, unknown>) => SourceAdapter> = {};

export function resolveAdapter(source: SourceConfig): SourceAdapter {
  if (source.adapter === "generic-selector") {
    return createGenericSelectorAdapter(source.config as unknown as GenericSelectorConfig);
  }
  const factory = custom[source.adapter];
  if (!factory) throw new Error(`Adapter "${source.adapter}" tidak terdaftar`);
  return factory(source.config);
}
