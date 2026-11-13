/** UI projections derived from the generated versioned OpenAPI contract. */
import type { components } from './schema';

// --- BASE & UTILITY TYPES ---

// Renamed from 'Info' to 'GenericInfo' to avoid ambiguity and clarify its purpose as a JSON fallback
export type GenericInfo = Record<string, unknown>;
/** Compatibility alias for existing API consumers. */
export type Info = GenericInfo;

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
}

// --- DIRECT OPENAPI PROJECTIONS ---
// Aliasing the deep schema path for cleaner extractions

type Schemas = components['schemas'];

export type Asset = Schemas['AssetOut'];
export type Assertion = Schemas['AssetTagOut'];
export type Resource = Schemas['ResourceOut'];
export type AssetDetail = Schemas['AssetDetailOut'];
export type SearchPage = Schemas['SearchPage'];

// --- DOMAIN ENTITIES ---

// Extracted nested array type into a dedicated interface for easier prop passing
export interface TagAlias {
  alias: string;
  language: string;
  alias_type: string;
}

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
  aliases: TagAlias[];
}

// Added literal union hints while allowing arbitrary strings from the backend 
// via the `(string & {})` trick, preserving IDE autocomplete without breaking on new backend states.
export type AlbumSortOrder = 'asc' | 'desc' | 'custom' | (string & {});

export interface Album {
  id: string;
  name: string;
  description: string | null;
  cover_asset_id: string | null;
  cover_url: string | null;
  asset_count: number;
  sort_order: AlbumSortOrder;
  created_at: string;
  updated_at: string;
}

export type JobStatus = 
  | 'queued' 
  | 'preparing' 
  | 'running' 
  | 'completed' 
  | 'failed' 
  | 'paused' 
  | 'cancelled' 
  | (string & {});

export interface Job {
  id: string;
  job_type: string;
  asset_id: string | null;
  batch_id: string | null;
  status: JobStatus;
  attempts: number;
  maximum_attempts: number;
  worker_id: string | null;
  progress: GenericInfo;
  error_code: string | null;
  error_details: GenericInfo | null;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
  scheduled_at: string;
  heartbeat_at: string | null;
}

// --- SEARCH & FILTERS ---
/** Optional server defaults remain optional while constructing editable query drafts. */

// Extracted comparison type to avoid massive inline brackets
export type FilterComparison = Schemas['FilterNode']['comparison'];

export type FilterNode = Omit<Schemas['FilterNode'], 'children' | 'comparison' | 'confidence'> & {
  children?: FilterNode[];
  comparison?: FilterComparison;
  confidence?: number;
};

export type SearchRequest = Omit<Schemas['SearchRequest'], 'filter' | 'minimum_similarity'> & {
  filter?: FilterNode | null;
  minimum_similarity?: number;
};

export interface SavedSearch {
  id: string;
  name: string;
  query: SearchRequest;
}

// --- SYSTEM CAPABILITIES & DUPLICATES ---

export type CapabilityState = 
  | 'operational' 
  | 'degraded' 
  | 'unavailable' 
  | 'not_configured' 
  | (string & {});

export interface Capability {
  state: CapabilityState;
  reason: string;
}

export type Capabilities = Record<string, Capability>;

export type DuplicateSafety = 'safe' | 'conflict' | 'ambiguous' | (string & {});

// Extracted nested array type to allow typing individual row components
export interface DuplicateMember {
  asset: Asset;
  asset_id: string;
  similarity: number;
  quality_rank: number;
}

export interface DuplicateGroup {
  id: string;
  duplicate_type: string;
  representative_asset_id: string | null;
  members: DuplicateMember[];
  safety: DuplicateSafety;
}
