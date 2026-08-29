/** Client-only tree projection types over normalized catalog entries. */
import type { ContextSchemeCapabilities } from "@meridian/contracts/context-uri";
import type {
  DocumentFileType,
  Filetype,
  ProjectContextTreeScheme,
  YjsTrackedSchemaType,
} from "@meridian/contracts/protocol";

type CatalogTreeFileBase = {
  kind: "file";
  documentId: string;
  name: string;
  path: string;
  uri: string;
  sizeBytes?: number;
  updatedAt?: string;
  readonly?: boolean;
  provisionalName: boolean;
};

export type CatalogTreeFile =
  | (CatalogTreeFileBase & {
      editable: true;
      filetype: Filetype;
      schemaType: YjsTrackedSchemaType;
    })
  | (CatalogTreeFileBase & {
      editable: false;
      fileType: DocumentFileType;
      mimeType?: string;
    });

export type CatalogTreeDirectory = {
  kind: "dir";
  name: string;
  path: string;
  uri: string;
  readonly?: boolean;
  children: CatalogTreeNode[];
};

export type CatalogTreeNode = CatalogTreeDirectory | CatalogTreeFile;

export type CatalogTreeProjection = {
  projectId: string;
  scheme: ProjectContextTreeScheme;
  capabilities: ContextSchemeCapabilities;
  tree: CatalogTreeDirectory;
};
