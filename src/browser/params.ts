// Bridge host-side parsing of the interaction/browserList and
// interaction/browserExecute reverse-RPC parameters. The request-context shape
// follows the official ZCode protocol broker at commit
// aac4755666d09fdcd70272fcf063c077a639015f (Apache-2.0), with one deliberate
// Bridge modification: identity fields (requestId/sessionId) stay required
// while advisory context fields (workspace/clientMode/...) are optional and
// unknown keys are stripped, so a modest field drift between the installed
// app-server and the observed commit degrades to absent advisory data instead
// of a hard protocol failure.
import { z } from "zod";
import { browserClientModeSchema } from "./command-metadata.js";
import { browserSessionContextKindSchema } from "./backend.js";
import { browserCommandSchema } from "./commands.js";

export const browserListParamsSchema = z
  .object({
    requestId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    workspaceKey: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1).optional(),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
  })
  .strip();
export type BrowserListParams = z.infer<typeof browserListParamsSchema>;

export const browserExecuteParamsSchema = z
  .object({
    requestId: z.string().trim().min(1),
    sessionId: z.string().trim().min(1),
    turnId: z.string().trim().min(1).optional(),
    workspaceKey: z.string().trim().min(1).optional(),
    workspacePath: z.string().trim().min(1).optional(),
    workspaceIdentity: z.string().trim().min(1).optional(),
    remoteSessionId: z.string().trim().min(1).optional(),
    clientMode: browserClientModeSchema.optional(),
    sessionContext: browserSessionContextKindSchema.optional(),
    browserId: z.string().trim().min(1),
    browserGeneration: z.number().int().nonnegative(),
    command: browserCommandSchema,
  })
  .strip();
export type BrowserExecuteParams = z.infer<typeof browserExecuteParamsSchema>;
