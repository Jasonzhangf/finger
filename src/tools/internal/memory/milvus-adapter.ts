/**
 * Milvus Lite Vector Store Adapter
 *
 * 使用 @zilliz/milvus2-sdk-node 操��� Milvus Lite
 * 提供向量索引和语义搜索能力
 */

import { MilvusClient } from '@zilliz/milvus2-sdk-node';
import { join } from 'path';
import { FINGER_PATHS } from '../../../core/finger-paths.js';
import { loadMemoryConfig } from './memory-config.js';
import type { EmbeddingAdapter } from './embedding-adapter.js';

export interface VectorEntry {
  id: string;
  embedding: number[];
  metadata: {
    title: string;
    content: string;
    type: string;
    tags: string;
    timestamp: string;
    scope: 'project' | 'system';
    projectPath?: string;
  };
}

export interface SearchResult {
  id: string;
  score: number;
  metadata: VectorEntry['metadata'];
}

const COLLECTION_NAME = 'memory_vectors';
const DIMENSION = 768; // 默认维度，会根据 embedding 动态调整

export class MilvusAdapter {
  private client: MilvusClient | null = null;
  private config: ReturnType<typeof loadMemoryConfig>;
  private initialized = false;
  private embeddingAdapter: EmbeddingAdapter;
  private actualDimension: number = DIMENSION;

  constructor(embeddingAdapter: EmbeddingAdapter, config?: ReturnType<typeof loadMemoryConfig>) {
    this.config = config ?? loadMemoryConfig();
    this.embeddingAdapter = embeddingAdapter;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    const dbPath = this.config.vectorStore.path || join(FINGER_PATHS.home, 'runtime', 'memory-vectors.db');

    this.client = new MilvusClient({
      address: dbPath,
    });

    // 检查集合是否存在，不存在则创建
    const hasCollection = await this.client.hasCollection({ collection_name: COLLECTION_NAME });

    if (!hasCollection.value) {
      await this.createCollection();
    }

    this.initialized = true;
  }

  private async createCollection(): Promise<void> {
    if (!this.client) throw new Error('Client not initialized');

    await this.client.createCollection({
      collection_name: COLLECTION_NAME,
      fields: [
        { name: 'id', data_type: 'VarChar', is_primary_key: true, max_length: 128 },
        { name: 'embedding', data_type: 'FloatVector', dim: this.actualDimension },
        { name: 'title', data_type: 'VarChar', max_length: 512 },
        { name: 'content', data_type: 'VarChar', max_length: 65535 },
        { name: 'type', data_type: 'VarChar', max_length: 64 },
        { name: 'tags', data_type: 'VarChar', max_length: 1024 },
        { name: 'timestamp', data_type: 'VarChar', max_length: 64 },
        { name: 'scope', data_type: 'VarChar', max_length: 32 },
        { name: 'projectPath', data_type: 'VarChar', max_length: 1024 },
      ],
    });

    // 创建向量索引
    await this.client.createIndex({
      collection_name: COLLECTION_NAME,
      field_name: 'embedding',
      index_type: 'AUTOINDEX',
      metric_type: 'COSINE',
    });

    // 加载集合到内存
    await this.client.loadCollectionSync({ collection_name: COLLECTION_NAME });
  }

  async insert(entry: VectorEntry): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Client not initialized');

    // 更新维度（如果需要）
    if (entry.embedding.length !== this.actualDimension) {
      this.actualDimension = entry.embedding.length;
      // 重新创建集合以适应新维度
      await this.client.dropCollection({ collection_name: COLLECTION_NAME });
      await this.createCollection();
    }

    await this.client.insert({
      collection_name: COLLECTION_NAME,
      data: [{
        id: entry.id,
        embedding: entry.embedding,
        title: entry.metadata.title.slice(0, 512),
        content: entry.metadata.content.slice(0, 65535),
        type: entry.metadata.type,
        tags: entry.metadata.tags,
        timestamp: entry.metadata.timestamp,
        scope: entry.metadata.scope,
        projectPath: entry.metadata.projectPath || '',
      }],
    });
  }

  async insertBatch(entries: VectorEntry[]): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Client not initialized');

    if (entries.length === 0) return;

    // 更新维度
    if (entries[0].embedding.length !== this.actualDimension) {
      this.actualDimension = entries[0].embedding.length;
      await this.client.dropCollection({ collection_name: COLLECTION_NAME });
      await this.createCollection();
    }

    const data = entries.map(entry => ({
      id: entry.id,
      embedding: entry.embedding,
      title: entry.metadata.title.slice(0, 512),
      content: entry.metadata.content.slice(0, 65535),
      type: entry.metadata.type,
      tags: entry.metadata.tags,
      timestamp: entry.metadata.timestamp,
      scope: entry.metadata.scope,
      projectPath: entry.metadata.projectPath || '',
    }));

    await this.client.insert({
      collection_name: COLLECTION_NAME,
      data,
    });
  }

  async search(
    queryEmbedding: number[],
    scope?: 'project' | 'system',
    projectPath?: string,
    limit: number = 10
  ): Promise<SearchResult[]> {
    await this.initialize();
    if (!this.client) throw new Error('Client not initialized');

    const filter: string[] = [];
    if (scope) {
      filter.push(`scope == "${scope}"`);
    }
    if (projectPath) {
      filter.push(`projectPath == "${projectPath}"`);
    }

    const result = await this.client.search({
      collection_name: COLLECTION_NAME,
      vector: queryEmbedding,
      limit,
      filter: filter.length > 0 ? filter.join(' and ') : '',
      output_fields: ['id', 'title', 'content', 'type', 'tags', 'timestamp', 'scope', 'projectPath'],
    });

    return result.results.map((item: any) => ({
      id: item.id,
      score: item.score,
      metadata: {
        title: item.title,
        content: item.content,
        type: item.type,
        tags: item.tags,
        timestamp: item.timestamp,
        scope: item.scope,
        projectPath: item.projectPath,
      },
    }));
  }

  async delete(id: string): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Client not initialized');

    await this.client.delete({
      collection_name: COLLECTION_NAME,
      ids: [id],
    });
  }

  async deleteBatch(ids: string[]): Promise<void> {
    await this.initialize();
    if (!this.client) throw new Error('Client not initialized');

    if (ids.length === 0) return;

    await this.client.delete({
      collection_name: COLLECTION_NAME,
      ids,
    });
  }

  async close(): Promise<void> {
    if (this.client) {
      await this.client.closeConnection();
      this.client = null;
      this.initialized = false;
    }
  }
}

let defaultAdapter: MilvusAdapter | null = null;

export function getMilvusAdapter(embeddingAdapter: EmbeddingAdapter): MilvusAdapter {
  if (!defaultAdapter) {
    defaultAdapter = new MilvusAdapter(embeddingAdapter);
  }
  return defaultAdapter;
}

export function resetMilvusAdapter(): void {
  defaultAdapter = null;
}
