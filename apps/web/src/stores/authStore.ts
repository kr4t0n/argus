import { create } from 'zustand';
import { clearToken, getToken, setToken } from '../lib/auth';
import { api } from '../lib/api';

interface AuthState {
  user: { id: string; email: string; role: string } | null;
  token: string | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  bootstrap: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  token: getToken(),
  loading: false,
  async login(email, password) {
    set({ loading: true });
    try {
      const res = await api.login(email, password);
      setToken(res.token);
      set({ token: res.token, user: res.user, loading: false });
    } catch (err) {
      set({ loading: false });
      throw err;
    }
  },
  logout() {
    clearToken();
    set({ user: null, token: null });
  },
  async bootstrap() {
    if (!getToken()) return;
    try {
      const { user } = await api.me();
      set({ user });
    } catch {
      clearToken();
      set({ user: null, token: null });
    }
  },
}));
