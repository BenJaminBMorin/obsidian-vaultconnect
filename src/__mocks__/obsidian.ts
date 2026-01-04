// Mock Obsidian API for testing

export interface App {
  workspace: unknown;
  vault: Vault;
  [key: string]: unknown;
}

export interface PluginManifest {
  id: string;
  name: string;
  version: string;
  [key: string]: unknown;
}

export class Plugin {
  app: App;
  manifest: PluginManifest;

  constructor() {
    this.app = { workspace: {}, vault: new Vault() };
    this.manifest = { id: 'test-plugin', name: 'Test Plugin', version: '1.0.0' };
  }

  async loadData(): Promise<Record<string, unknown>> {
    return {};
  }

  async saveData(data: Record<string, unknown>): Promise<void> {
    // Mock implementation
  }
}

export class TFile {
  path: string;
  name: string;
  extension: string;
  stat: { mtime: number; ctime: number; size: number };
  
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || '';
    this.extension = this.name.split('.').pop() || '';
    this.stat = {
      mtime: Date.now(),
      ctime: Date.now(),
      size: 0
    };
  }
}

export class TAbstractFile {
  path: string;
  name: string;
  
  constructor(path: string) {
    this.path = path;
    this.name = path.split('/').pop() || '';
  }
}

export class Vault {
  async read(file: TFile): Promise<string> {
    return '';
  }
  
  async modify(file: TFile, content: string): Promise<void> {
    // Mock implementation
  }
  
  async create(path: string, content: string): Promise<TFile> {
    return new TFile(path);
  }
  
  async delete(file: TFile): Promise<void> {
    // Mock implementation
  }
  
  getAbstractFileByPath(path: string): TAbstractFile | null {
    return null;
  }
  
  getMarkdownFiles(): TFile[] {
    return [];
  }
}

export class Notice {
  constructor(message: string, timeout?: number) {
    // Mock implementation
  }
}

export class Modal {
  app: App;

  constructor(app: App) {
    this.app = app;
  }

  open(): void {
    // Mock implementation
  }

  close(): void {
    // Mock implementation
  }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {
    // Mock implementation
  }

  hide(): void {
    // Mock implementation
  }
}
