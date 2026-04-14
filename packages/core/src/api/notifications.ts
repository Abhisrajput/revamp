/**
 * Notification adapter — platform-agnostic toast/alert interface.
 *
 * Web: sonner toast + notification store
 * VS Code: vscode.window.showInformationMessage
 * Desktop: electron Notification
 */

export interface NotificationAdapter {
  success(title: string, message: string, metadata?: Record<string, unknown>): void;
  error(title: string, message: string, metadata?: Record<string, unknown>): void;
  info(title: string, message: string, metadata?: Record<string, unknown>): void;
}

let _notifier: NotificationAdapter | null = null;

export function setNotificationAdapter(adapter: NotificationAdapter) {
  _notifier = adapter;
}

export function getNotifier(): NotificationAdapter {
  if (!_notifier) {
    // Fallback: console logging
    return {
      success: (t, m) => console.log(`[SUCCESS] ${t}: ${m}`),
      error: (t, m) => console.error(`[ERROR] ${t}: ${m}`),
      info: (t, m) => console.log(`[INFO] ${t}: ${m}`),
    };
  }
  return _notifier;
}
