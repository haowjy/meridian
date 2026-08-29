/** Project-domain lifecycle notification implemented by the context catalog adapter. */
export interface ContextCatalogLifecyclePort {
  /** Must persist lifecycle metadata in the caller's ambient transaction. */
  refreshProject(projectId: string): Promise<void>;
}
