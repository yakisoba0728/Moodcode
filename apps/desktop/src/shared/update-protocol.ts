export interface DesktopAppUpdate {
  state: 'disabled' | 'idle' | 'checking' | 'available' | 'downloading' | 'downloaded' | 'installing' | 'failed';
  currentVersion: string;
  channel: 'stable';
  version?: string;
  progress?: number;
  reason?: string;
  error?: { code: string; message: string };
}
export interface DesktopAppUpdateAction {
  action: 'check' | 'download' | 'cancel' | 'install';
  version?: string;
  acknowledged?: true;
}
