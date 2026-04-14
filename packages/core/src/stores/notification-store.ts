import { create } from 'zustand';

export type NotificationType =
  | 'pipeline_started'
  | 'stage_completed'
  | 'stage_failed'
  | 'approval_required'
  | 'approval_granted'
  | 'approval_rejected'
  | 'system_alert'
  | 'info';

export interface Notification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface NotificationState {
  notifications: Notification[];
  unreadCount: number;
  addNotification: (n: Partial<Notification> & { type: NotificationType; title: string; message: string }) => void;
  removeNotification: (id: string) => void;
  markAsRead: (id: string) => void;
  markAllRead: () => void;
  clearAll: () => void;
}

export const useNotificationStore = create<NotificationState>((set, _get) => ({
  notifications: [],
  unreadCount: 0,

  addNotification: (n) => {
    const notification: Notification = {
      id: n.id ?? crypto.randomUUID(),
      type: n.type,
      title: n.title,
      message: n.message,
      read: n.read ?? false,
      timestamp: n.timestamp ?? new Date().toISOString(),
      metadata: n.metadata,
    };
    set((state) => ({
      notifications: [notification, ...state.notifications].slice(0, 100),
      unreadCount: state.unreadCount + (notification.read ? 0 : 1),
    }));
  },

  removeNotification: (id) => {
    set((state) => {
      const removed = state.notifications.find((n) => n.id === id);
      return {
        notifications: state.notifications.filter((n) => n.id !== id),
        unreadCount: removed && !removed.read ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      };
    });
  },

  markAsRead: (id) => {
    set((state) => {
      let decremented = false;
      const notifications = state.notifications.map((n) => {
        if (n.id === id && !n.read) {
          decremented = true;
          return { ...n, read: true };
        }
        return n;
      });
      return {
        notifications,
        unreadCount: decremented ? Math.max(0, state.unreadCount - 1) : state.unreadCount,
      };
    });
  },

  markAllRead: () => {
    set((state) => ({
      notifications: state.notifications.map((n) => ({ ...n, read: true })),
      unreadCount: 0,
    }));
  },

  clearAll: () => set({ notifications: [], unreadCount: 0 }),
}));
