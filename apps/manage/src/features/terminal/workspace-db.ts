import Dexie, { type Table } from 'dexie';

export type WorkspaceDocument = {
  id: string;
  targetId: string;
  name: string;
  content: string;
  saved: string;
  path?: string;
  version?: string;
  updatedAt: number;
};

export type WorkspaceSession = {
  targetId: string;
  activeId: string;
  remotePath: string;
  updatedAt: number;
};

class WorkspaceDatabase extends Dexie {
  documents!: Table<WorkspaceDocument, string>;
  sessions!: Table<WorkspaceSession, string>;

  constructor() {
    super('rod-manage-code-workspace');
    this.version(1).stores({
      documents: 'id, targetId, [targetId+path], updatedAt',
      sessions: 'targetId',
    });
  }
}

export const workspaceDb = new WorkspaceDatabase();

export async function restoreWorkspace(targetId: string) {
  const [documents, session] = await Promise.all([
    workspaceDb.documents.where('targetId').equals(targetId).toArray(),
    workspaceDb.sessions.get(targetId),
  ]);
  return { documents: documents.sort((a, b) => a.updatedAt - b.updatedAt), session };
}

export async function persistWorkspace(targetId: string, documents: WorkspaceDocument[],
  activeId: string, remotePath: string) {
  await workspaceDb.transaction('rw', workspaceDb.documents, workspaceDb.sessions, async () => {
    const existing = await workspaceDb.documents.where('targetId').equals(targetId).primaryKeys();
    const current = new Set(documents.map(doc => doc.id));
    const removed = existing.filter(id => !current.has(id));
    if (removed.length) await workspaceDb.documents.bulkDelete(removed);
    if (documents.length) await workspaceDb.documents.bulkPut(documents);
    await workspaceDb.sessions.put({ targetId, activeId, remotePath, updatedAt: Date.now() });
  });
}
