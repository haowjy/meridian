/** Real cross-domain Work projection participant for isolated PostgreSQL adapter tests. */
import type { Database } from "@meridian/database";
import { createDrizzleContextCatalog } from "../domains/context/adapters/context-catalog.js";
import { createDrizzleProjectContextAvailability } from "../domains/context/adapters/project-context-availability.js";
import { createWorkProjectionMutation } from "../domains/projects/adapters/work-projection-mutation.js";

export function createTestWorkProjectionMutation(db: Database) {
  const availability = createDrizzleProjectContextAvailability(db);
  return createWorkProjectionMutation({
    db,
    availability,
    catalog: createDrizzleContextCatalog(db, undefined, {
      availabilityMutations: availability,
    }),
  });
}
