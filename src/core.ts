// Supported composition surface for calling hosts. Do not import internal files.
export * from "./interfaces.js";
export { buildTaskFeedbackSnapshotV01 } from "./feedback/task-feedback.js";
export { renderTaskFeedback } from "./feedback/renderer.js";
export { codexHostProfile, validateHostProfile, type BridgeHostProfile } from "./host/profile.js";
export { TaskStore } from "./store/task-store.js";
export { BridgeTaskManager, type TaskManagerOptions } from "./manager/task-manager.js";
export { createWorkerSpawner } from "./manager/spawn-worker.js";
export { DirectWorkspaceProvider } from "./workspace/direct-provider.js";
export { createBridgeServer, SERVER_VERSION, type BridgeServerOptions } from "./mcp/server.js";
export { NodeRuntimeResolver, loadPersistedRuntimeEnvironment } from "./runtime/resolver.js";
export { ZCodeModelSettings } from "./runtime/model-settings.js";
export { runBridgeDoctor } from "./runtime/doctor.js";
export { runWorkerTask, type RunWorkerTaskOptions } from "./worker/run-task.js";
export { ZCodeAppServerAdapter } from "./adapters/zcode-app-server-adapter.js";
export { BridgeError, type BridgeErrorCode } from "./runtime/errors.js";
export { TaskManagerError } from "./manager/errors.js";
export type { ZCodeModelCatalog, ZCodeModelCatalogEntry, DefaultModelSelection } from "./runtime/model-settings.js";
export { startBridge } from "./host/stdio.js";
