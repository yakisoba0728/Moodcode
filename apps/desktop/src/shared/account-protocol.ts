export interface DesktopAccount {
  id: string;
  providerId: 'chatgpt';
  label: string;
  state: 'connected' | 'signed-out' | 'expired' | 'failed';
  sharing: boolean;
  expiresAt?: number;
}

/** Only verified display metadata crosses IPC. Credentials and registrations stay in main. */
export interface DesktopAccountView {
  accounts: DesktopAccount[];
  activeAccountId?: string;
  pending: boolean;
  secureStorage: 'available' | 'unavailable';
  models: { id: string; displayName: string }[];
  revision: number;
  error?: { code: string; message: string };
}

export interface DesktopAccountAction {
  action: 'sign-in' | 'select' | 'refresh' | 'sign-out' | 'forget' | 'cancel';
  accountId?: string;
}
