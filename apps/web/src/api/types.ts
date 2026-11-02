/** UI projections derived from the generated versioned OpenAPI contract. */
import type { components } from './schema';
export type Info = Record<string, unknown>;
export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}
export type Asset = components['schemas']['AssetOut'];
export type Assertion = components['schemas']['AssetTagOut'];
export type Resource = components['schemas']['ResourceOut'];
export type AssetDetail = components['schemas']['AssetDetailOut'];
export interface Tag {
  id: string;
  canonical_key: string;
  display_name: string;
  category: string;
  description: string | null;
  enabled: boolean;
  minimum_confidence: number;
  is_sensitive: boolean;
  sync_eligible: boolean;
  parent_id: string | null;
  merged_into_id: string | null;
  aliases: { alias: string; language: string; alias_type: string }[];
}
export interface Album {
  id: string;
  name: string;
  description: string | null;
  cover_asset_id: string | null;
  cover_url: string | null;
  asset_count: number;
  sort_order: string;
  created_at: string;
  updated_at: string;
}
export interface Job {
  id: string;
  job_type: string;
  asset_id: string | null;
  batch_id: string | null;
  status: string;
  attempts: number;
  maximum_attempts: number;
  worker_id: string | null;
  progress: Info;
  error_code: string | null;
  error_details: Info | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  scheduled_at: string;
  heartbeat_at: string | null;
}
/** Optional server defaults remain optional while constructing editable query drafts. */
export type FilterNode = Omit<
  components['schemas']['FilterNode'],
  'children' | 'comparison' | 'confidence'
> & {
  children?: FilterNode[];
  comparison?: components['schemas']['FilterNode']['comparison'];
  confidence?: number;
};
export type SearchRequest = Omit<components['schemas']['SearchRequest'], 'filter' | 'minimum_similarity'> & {
  filter?: FilterNode | null;
  minimum_similarity?: number;
};
export type SearchPage = components['schemas']['SearchPage'];
export interface Capability {
  state: string;
  reason: string;
}
export type Capabilities = Record<string, Capability>;
export interface DuplicateGroup {
  id: string;
  duplicate_type: string;
  representative_asset_id: string | null;
  members: { asset: Asset; asset_id: string; similarity: number; quality_rank: number }[];
  safety: string;
}
export interface SavedSearch {
  id: string;
  name: string;
  query: SearchRequest;
}
