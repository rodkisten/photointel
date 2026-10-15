/** UI projections matching the versioned OpenAPI schemas. Never contains secrets. */
export type Info = Record<string, unknown>;
export interface Page<T> { items: T[]; next_cursor: string | null }
export interface Asset {
  id: string; library_id: string; source_asset_key: string; media_type: string;
  filename: string; captured_at: string | null; added_at: string | null;
  width: number | null; height: number | null; duration: number | null;
  filesize: number | null; content_revision: string; representation_revision: string;
  ingestion_status: string; classification_status: string; visibility_status: string;
  quality: Info; last_error: string | null; created_at: string;
  thumbnail_url: string | null; ranking?: Info | null;
}
export interface Assertion {
  id: string; tag_id: string; canonical_key: string; display_name: string;
  category: string; origin: string; confidence: number | null; model_version: string;
  user_status: string; review_status: string; is_sensitive: boolean;
}
export interface Resource {
  id: string; resource_type: string; media_url: string | null; mime_type: string | null;
  width: number | null; height: number | null; byte_size: number | null; status: string;
}
export interface AssetDetail extends Asset {
  metadata: Info | null; resources: Resource[]; tags: Assertion[];
  inference_runs: Info[]; mapping_status: string;
}
export interface Tag {
  id: string; canonical_key: string; display_name: string; category: string;
  description: string | null; enabled: boolean; minimum_confidence: number;
  is_sensitive: boolean; sync_eligible: boolean; parent_id: string | null;
  merged_into_id: string | null;
  aliases: { alias: string; language: string; alias_type: string }[];
}
export interface Album {
  id: string; name: string; description: string | null; cover_asset_id: string | null;
  cover_url: string | null; asset_count: number; sort_order: string;
  created_at: string; updated_at: string;
}
export interface Job {
  id: string; job_type: string; asset_id: string | null; batch_id: string | null;
  status: string; attempts: number; maximum_attempts: number; worker_id: string | null;
  progress: Info; error_code: string | null; error_details: Info | null;
  started_at: string | null; finished_at: string | null; created_at: string;
  scheduled_at: string; heartbeat_at: string | null;
}
export interface FilterNode {
  op: 'and' | 'or' | 'not' | 'tag' | 'text' | 'date' | 'number' | 'media_type' |
    'source' | 'album' | 'duplicate' | 'quality' | 'screenshots';
  children?: FilterNode[]; key?: string; value?: string | number | boolean;
  comparison?: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte';
  minimum?: number | string; maximum?: number | string; confidence?: number;
  origin?: 'apple' | 'joytag' | 'user' | 'import' | 'external';
}
export interface SearchRequest {
  query?: string; filter?: FilterNode; source_asset_id?: string;
  sort: 'captured_desc' | 'added_desc' | 'relevance' | 'quality_desc' | 'filesize_asc';
  limit: number; cursor?: string;
}
export interface SearchPage extends Page<Asset> { explanation: Info }
export interface Capability { state: string; reason: string }
export type Capabilities = Record<string, Capability>;
export interface DuplicateGroup {
  id: string; duplicate_type: string; representative_asset_id: string | null;
  members: { asset: Asset; asset_id: string; similarity: number; quality_rank: number }[];
  safety: string;
}
export interface SavedSearch { id: string; name: string; query: SearchRequest }
