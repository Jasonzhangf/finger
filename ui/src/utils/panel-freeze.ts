export type PanelFreezeKey = 'left' | 'canvas' | 'right' | 'bottom' | 'performance';
export type UiDisableKey = 'realtime' | 'polling' | 'canvas' | 'right' | 'bottom' | 'performance';

export const PANEL_FREEZE_STORAGE_KEY = 'finger-ui-panel-freeze';
export const UI_DISABLE_STORAGE_KEY = 'finger-ui-disable-flags';

export function isPanelFrozen(key: PanelFreezeKey): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(PANEL_FREEZE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<Record<PanelFreezeKey, boolean>>;
    return parsed?.[key] === true;
  } catch {
    return false;
  }
}

export function isUiDisabled(key: UiDisableKey): boolean {
  if (typeof window === 'undefined' || !window.localStorage) return false;
  try {
    const raw = window.localStorage.getItem(UI_DISABLE_STORAGE_KEY);
    if (!raw) return false;
    const parsed = JSON.parse(raw) as Partial<Record<UiDisableKey, boolean>>;
    return parsed?.[key] === true;
  } catch {
    return false;
  }
}
