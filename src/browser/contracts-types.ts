// Bridge-local type barrel: the upstream adapter modules import their command
// and result types from @zcode/contracts; the Bridge vendors the same schemas
// in this package, so this module re-exports those types from their real
// sources under one import specifier to keep the adapted files close to
// upstream.
export type { BrowserCommand, BrowserKeyModifier, BrowserPoint } from "./commands.js";
export type {
  BrowserPageState,
  BrowserErrorCode,
} from "./command-metadata.js";
export type { BrowserCommandResult } from "./result.js";
export type {
  BrowserPlaywrightAction,
  BrowserPlaywrightModifier,
} from "./commands.js";
