export const API_BASE = import.meta.env.DEV
  ? ''  // Vite dev proxy handles /api → localhost:7890
  : 'http://127.0.0.1:__BG_MANAGER_PORT__'
