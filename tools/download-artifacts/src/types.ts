export interface ServerSpec {
  minecraft_version: string;
  paper_build: "latest" | number;
  jvm: { heap_mb: number };
}

export type PluginSpec =
  | { name: string; source: "geysermc"; project: string; preserve?: string[] }
  | { name: string; source: "hangar"; id: string; version: string; preserve?: string[] }
  | { name: string; source: "modrinth"; id: string; version: string; preserve?: string[] }
  | {
      name: string;
      source: "github";
      repo: string;
      version: string;
      assetPattern: string;
      sha256?: string;
      preserve?: string[];
    }
  | { name: string; source: "curseforge"; projectId: number; fileId: number; preserve?: string[] }
  | { name: string; source: "url"; url: string; sha256?: string; preserve?: string[] }
  | { name: string; source: "local"; path: string; preserve?: string[] };

export interface PluginsSpec {
  plugins: PluginSpec[];
}

/** AMI / Docker イメージに焼き込まれ、sync-dist.sh と mc-start.sh が参照する */
export interface Manifest {
  minecraft_version: string;
  paper_build: string;
  jvm: { heap_mb: number };
  preserve: string[];
  plugins: { name: string; source: string; resolved: string }[];
  generated_at: string;
}
