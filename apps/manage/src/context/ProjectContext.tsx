import { createContext, useContext, type ReactNode } from 'react';

export interface ManageProject {
  id: string;
  name: string;
  repository: string;
  enabled: boolean;
  status?: string;
}

export interface ProjectContextValue {
  project: ManageProject | null;
  projects: readonly ManageProject[];
  isLoading: boolean;
  isReadOnly: boolean;
  selectProject: (repository: string) => void;
}

const ProjectContext = createContext<ProjectContextValue | null>(null);

export function ProjectProvider({ value, children }: { value: ProjectContextValue; children: ReactNode }) {
  return <ProjectContext.Provider value={value}>{children}</ProjectContext.Provider>;
}

export function useProject(): ProjectContextValue {
  const context = useContext(ProjectContext);
  if (!context) throw new Error('useProject must be used inside ProjectProvider');
  return context;
}
