/** Public SDK + InteractiveMode route verified against external Pi1.5.2. */
export const SUPPORTED_PI_VERSIONS = ['1.5.2'] as const;
export function supportsPiVersion(version: string) {
  return (SUPPORTED_PI_VERSIONS as readonly string[]).includes(version);
}
