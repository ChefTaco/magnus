// ─── Library: local document & asset management ───

export interface LibraryCategory {
  id: string;
  name: string;
  description: string;
  color: string;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
  fileCount?: number;
}

export interface LibraryFile {
  id: string;
  name: string;
  fileName: string;
  mimeType: string;
  content: string;
  sizeBytes: number;
  categoryId: string | null;
  tags: string[];
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  category?: LibraryCategory | null;
}

export interface LibraryCategoryCreateRequest {
  name: string;
  description?: string;
  color?: string;
  sortOrder?: number;
}

export interface LibraryCategoryUpdateRequest {
  name?: string;
  description?: string;
  color?: string;
  sortOrder?: number;
}

export interface LibraryFileCreateRequest {
  name: string;
  fileName: string;
  mimeType?: string;
  content: string;
  categoryId?: string | null;
  tags?: string[];
}

export interface LibraryFileUpdateRequest {
  name?: string;
  fileName?: string;
  mimeType?: string;
  content?: string;
  categoryId?: string | null;
  tags?: string[];
}

export interface LibraryFileMoveCategoryRequest {
  fileIds: string[];
  categoryId: string | null;
}

export interface LibrarySearchParams {
  query?: string;
  categoryId?: string;
  mimeType?: string;
  tags?: string[];
  page?: number;
  pageSize?: number;
}

// ─── Library deploy types ───

export interface LibraryDeployRequest {
  fileId: string;
  nodeIds: string[];
  overwrite?: boolean;
}

export interface LibraryDeployResult {
  nodeId: string;
  nodeName: string;
  status: 'success' | 'failed';
  error?: string;
}

// ─── Scan types ───

export type NodeScanStatus = 'scanning' | 'done' | 'error';

export interface DiscoveredSkill {
  name: string;
  version: string;
  description: string;
  author: string;
  entryPoint: string;
  dependencies: string[];
  tags: string[];
  files: Array<{ name: string; content: string }>;
}

export interface DiscoveredCronJob {
  name: string;
  schedule: string;
  command: string;
}

export interface NodeSkillScanResult {
  nodeId: string;
  nodeName: string;
  status: NodeScanStatus;
  skills: DiscoveredSkill[];
  error?: string;
}

export interface NodeCronScanResult {
  nodeId: string;
  nodeName: string;
  status: NodeScanStatus;
  jobs: DiscoveredCronJob[];
  error?: string;
}
