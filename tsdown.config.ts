/**
 * Standalone tsdown config for the remote-workspace plugin.
 *
 * Uses this repository's own client-bundle preset (build/tsdown.client.ts — a
 * closure-factory artifact for window.__ModuleLoader__, CSS Modules inlined,
 * externals resolved through the loader module table). It was lifted from the
 * dsh-web monorepo's `shared/tsdown.client.ts` together with the platform seed
 * table it reads, so this package builds without that repository present. The
 * node half builds from src (tsdown compiles TS directly) and types ship from
 * lib/types (tsc).
 */
import { clientBundle } from './build/tsdown.client.ts'

export default clientBundle('@njjpro/dsh-remote-workspace', ['src/index.ts'])
