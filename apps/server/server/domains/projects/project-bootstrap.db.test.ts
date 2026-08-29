/** PostgreSQL contract for Work-free project bootstrap. */
import { beforeEach, describe, expect, it } from "vitest";

const RUN = process.env.RUN_DB_TESTS === "1" || process.env.RUN_DB_TESTS === "true";
const DATABASE_URL = process.env.DATABASE_URL;
if (!RUN || !DATABASE_URL) describe.skip("Work-free project bootstrap (postgres)", () => {});
else
  describe("Work-free project bootstrap (postgres)", async () => {
    const { Hocuspocus } = await import("@hocuspocus/server");
    const schema = await import("@meridian/database/schema");
    const { conformanceUserValues } = await import(
      "@meridian/database/__test-support__/db-fixtures"
    );
    const { eq } = await import("drizzle-orm");
    const { createCollabDomain } = await import("../collab/composition.js");
    const { createDrizzleDocumentAccess } = await import("../../lib/document-access.js");
    const { useRollbackTestDatabase } = await import(
      "../../test-support/rollback-test-database.js"
    );
    const { truncateDrizzleTables } = await import("../../test-support/drizzle-reset.js");
    const { createDrizzleProjectBootstrapRepository } = await import("./index.js");
    const { createProjectContextDocumentStore } = await import(
      "../context/context-source-provisioning.js"
    );
    const { runInDrizzleTransaction } = await import("../../shared/drizzle-transaction.js");
    const USER_ID = "00000000-0000-4000-8000-000000000751";
    const database = useRollbackTestDatabase(DATABASE_URL, {
      prepareSuite: (db) => truncateDrizzleTables(db, [schema.users]),
    });
    let db = database.current;
    beforeEach(async () => {
      db = database.current;
      await db.insert(schema.users).values(conformanceUserValues(USER_ID, "no-work-bootstrap"));
    });
    function collab() {
      const domain = createCollabDomain({ db, documentAccess: createDrizzleDocumentAccess(db) });
      domain.bindHocuspocus(
        new Hocuspocus({
          yDocOptions: { gc: false, gcFilter: () => true },
          onStoreDocument: ({ documentName, document }) =>
            domain.storeHocuspocusDocument(documentName, document),
        }),
      );
      return domain;
    }
    it("converges project, Writer, manuscript and unassigned sources without a Work or thread", async () => {
      const repository = createDrizzleProjectBootstrapRepository({ db, documents: collab() });
      const first = await repository.ensureDefaultBootstrap(USER_ID as never);
      const second = await repository.ensureDefaultBootstrap(USER_ID as never);
      expect(second).toEqual(first);
      expect(Object.keys(first).sort()).toEqual([
        "agentDefinitionId",
        "documentId",
        "manuscriptSourceId",
        "projectId",
        "uri",
      ]);
      const [sources, workRows, threadRows, agents, docs] = await Promise.all([
        db
          .select({ slug: schema.contextSources.slug, workId: schema.contextSources.workId })
          .from(schema.contextSources)
          .where(eq(schema.contextSources.projectId, first.projectId)),
        db.select().from(schema.works).where(eq(schema.works.projectId, first.projectId)),
        db.select().from(schema.threads).where(eq(schema.threads.projectId, first.projectId)),
        db
          .select()
          .from(schema.agentDefinitions)
          .where(eq(schema.agentDefinitions.projectId, first.projectId)),
        db.select().from(schema.documents).where(eq(schema.documents.id, first.documentId)),
      ]);
      expect(sources).toEqual(
        expect.arrayContaining([
          { slug: "manuscript", workId: null },
          { slug: "scratch", workId: null },
          { slug: "uploads", workId: null },
        ]),
      );
      expect(workRows).toEqual([]);
      expect(threadRows).toEqual([]);
      expect(agents).toHaveLength(1);
      expect(docs).toHaveLength(1);
    });

    it("rolls project source provisioning back with its ambient transaction", async () => {
      const projectId = crypto.randomUUID();
      await db.insert(schema.projects).values({
        id: projectId,
        userId: USER_ID,
        name: "Ambient source",
        slug: `ambient-${projectId}`,
      });
      const store = createProjectContextDocumentStore(db, projectId, "scratch", USER_ID);
      await expect(
        runInDrizzleTransaction(db, () =>
          store.transaction(async () => {
            await store.createFolder(null, "rolled-back");
            throw new Error("rollback");
          }),
        ),
      ).rejects.toThrow("rollback");
      await expect(
        db
          .select()
          .from(schema.contextSources)
          .where(eq(schema.contextSources.projectId, projectId)),
      ).resolves.toEqual([]);
      await expect(store.createFolder(null, "retry")).resolves.toBeDefined();
    });
  });
