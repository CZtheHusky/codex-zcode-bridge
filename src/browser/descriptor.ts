// Adapted from the public ZCode source at commit
// aac4755666d09fdcd70272fcf063c077a639015f (Apache-2.0):
//   apps/zcode-cli/packages/adapters/src/browser/<file>
// Bridge modifications are annotated in place and limited to module boundaries
// (local schema/contract modules instead of @zcode/contracts) plus the changes
// required by the Bridge host lifecycle documented in ADR-007.
import type { BrowserBackendDescriptor } from "./backend.js";

export function createManagedCdpDescriptor(
  browserId: string,
  generation: number,
): BrowserBackendDescriptor {
  return {
    id: browserId,
    generation,
    type: "cdp",
    // Bridge modification: this backend is the Bridge's own managed headless
    // CDP runtime, not the ZCode CLI's; the name and metadata identify the
    // actual provider so discovery never misrepresents the host.
    name: "Bridge Managed Headless Chromium",
    capabilities: {
      browser: [],
      tab: [],
    },
    apiSupportOverrides: {
      "BrowserUser.openTabs": false,
      "BrowserUser.history": false,
      "PlaywrightAPI.waitForEvent": false,
      "PlaywrightDownload.path": false,
      "PlaywrightFileChooser.setFiles": false,
      "PlaywrightLocator.downloadMedia": false,
      "PlaywrightLocator.evaluate": false,
      "CUAAPI.downloadMedia": false,
      "DomCUAAPI.downloadMedia": false,
    },
    metadata: {
      provider: "codex-zcode-bridge",
      launchMode: "managed",
      headless: "true",
    },
  };
}
