import { reapStartupChildren } from "./restart-children";

// Keep this entrypoint-only: SDK imports may already own Bun subprocesses.
reapStartupChildren();
